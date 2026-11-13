const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { dynamicTools, editFile } = require('../fileEditTools')
const { unifiedDiff } = require('../unifiedDiff')

function makeView(root = '/repo') {
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try { delete require.cache[require.resolve('../extension')]; ({ DicodeView } = require('../extension')) } finally { Module._load = originalLoad }
  const data = new Map([['dicodeCodex.thread', { id: 'thread', cwd: root, dynamicToolsEnabled: true }]])
  const context = {
    extensionPath: path.join(__dirname, '..'),
    globalState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => { data.set(key, value) } },
    secrets: { get: async () => null },
  }
  const view = new DicodeView(context)
  const posted = []
  view.view = { webview: { postMessage: message => posted.push(message) } }
  view.models = [{ id: 'm' }]
  view.loadedThreadId = 'thread'
  return { view, posted, vscode }
}
function rpc(view, method, params) { view.onCodexEvent({ type: 'rpc', message: { method, params } }) }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('older asynchronous state cannot replace a loaded model list', async () => {
  const { view, posted } = makeView()
  const pending = []
  view.tokens = () => new Promise(resolve => pending.push(resolve))
  view.models = []
  const old = view.postState()
  view.models = [{ id: 'm' }]
  const latest = view.postState()
  pending[1]({ access_token: 'token' }); await latest
  pending[0]({ access_token: 'token' }); await old
  assert.deepEqual(posted.map(message => message.models), [[{ id: 'm' }]])
  view.dispose()
})

test('model loading reports errors and supports retry', async () => {
  const { view } = makeView()
  view.accessToken = async () => 'token'
  view.maybeGenerateTitle = () => {}
  Object.defineProperty(view, 'serverUrl', { value: 'https://example.test' })
  view.json = async () => { throw new Error('offline') }
  await view.loadModels()
  assert.match(view.modelsError, /offline/)
  view.json = async () => ({ data: [{ id: 'm', contextWindow: 100000 }] })
  await view.loadModels()
  assert.equal(view.modelsError, null)
  assert.equal(view.models[0].contextWindow, 100000)
  view.dispose()
})

test('model authorization failure refreshes once and retries with the new token', async () => {
  const { view } = makeView()
  const refreshes = [], requests = []
  Object.defineProperty(view, 'serverUrl', { value: 'https://example.test' })
  view.maybeGenerateTitle = () => {}
  view.accessToken = async force => { refreshes.push(!!force); return force ? 'new' : 'old' }
  view.json = async (_url, token) => {
    requests.push(token)
    if (token === 'old') throw Object.assign(new Error('unauthorized'), { status: 401 })
    return { data: [{ id: 'm' }] }
  }
  await view.loadModels()
  assert.deepEqual(refreshes, [false, true])
  assert.deepEqual(requests, ['old', 'new'])
  assert.equal(view.modelsError, null)
  view.dispose()
})

test('rejected model credentials give a relogin prompt without endless retry', async () => {
  const { view } = makeView()
  let calls = 0
  Object.defineProperty(view, 'serverUrl', { value: 'https://example.test' })
  view.accessToken = async () => 'token'
  view.json = async () => { calls++; throw Object.assign(new Error('models 返回 401'), { status: 401 }) }
  await view.loadModels()
  assert.equal(calls, 2)
  assert.match(view.modelsError, /重新登录/)
  view.dispose()
})

test('item diagnostics identify command actions and real file changes without command text', () => {
  const { view } = makeView()
  const lines = []
  view.output.appendLine = line => lines.push(line)
  rpc(view, 'item/started', { turnId: 't', item: { id: 'c', type: 'commandExecution', command: 'private command', commandActions: [{ type: 'read' }] } })
  rpc(view, 'item/completed', { turnId: 't', item: { id: 'p', type: 'fileChange', status: 'completed', changes: [{ path: 'a.txt' }] } })
  assert.match(lines[0], /type=commandExecution.*actions=read/)
  assert.match(lines[1], /type=fileChange.*changes=1/)
  assert.equal(lines.join(' ').includes('private command'), false)
  view.dispose()
})

test('thread usage follows the active thread and survives history snapshots', () => {
  const { view, posted } = makeView()
  view.activeModel = 'm'
  const usage = { last: { totalTokens: 45000, inputTokens: 40000, outputTokens: 5000 }, total: { totalTokens: 90000 }, modelContextWindow: 128000 }
  rpc(view, 'thread/tokenUsage/updated', { threadId: 'other', tokenUsage: usage })
  assert.equal(view.conversation.tokenUsage, null)
  rpc(view, 'thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: usage })
  assert.equal(posted.at(-1).tokenUsage.last.totalTokens, 45000)
  assert.equal(view.conversation.snapshot().tokenUsage.modelId, 'm')
  view.dispose()
})

test('manual compaction calls the CLI and its item events settle the turn', async () => {
  const { view, posted } = makeView()
  const calls = []
  view.ensureClient = async () => ({ request: async (method, params) => { calls.push({ method, params }); return {} } })
  await view.handle({ type: 'compactContext' })
  assert.equal(view.busy, true)
  assert.deepEqual(calls, [{ method: 'thread/compact/start', params: { threadId: 'thread' } }])
  rpc(view, 'turn/started', { threadId: 'thread', turn: { id: 'compact-turn', status: 'inProgress' } })
  rpc(view, 'item/started', { turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } })
  rpc(view, 'item/completed', { turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } })
  rpc(view, 'turn/completed', { turnId: 'compact-turn', turn: { id: 'compact-turn', status: 'completed' } })
  assert.equal(view.busy, false)
  assert.ok(posted.some(message => message.params?.item?.type === 'contextCompaction'))
  view.dispose()
})

test('selected reasoning effort is sent to the CLI for the turn', async () => {
  const { view } = makeView()
  const calls = []
  view.ensureClient = async () => ({ request: async (method, params) => { calls.push({ method, params }); return { turn: { id: 'turn' } } } })
  await view.send('hello', 'm', 'high')
  assert.equal(calls.find(call => call.method === 'turn/start').params.effort, 'high')
  view.dispose()
})

test('failed manual compaction clears busy state', async () => {
  const { view } = makeView()
  view.ensureClient = async () => ({ request: async () => { throw new Error('unavailable') } })
  await assert.rejects(view.handle({ type: 'compactContext' }), /unavailable/)
  assert.equal(view.busy, false)
  view.dispose()
})

test('shell writes retain only the Codex command event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-shell-edit-'))
  try {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'before\n')
    fs.writeFileSync(path.join(root, 'removed.txt'), 'gone\n')
    const { view, posted } = makeView(root)
    rpc(view, 'turn/started', { turn: { id: 't' } })
    rpc(view, 'item/started', { turnId: 't', item: { id: 'cmd', type: 'commandExecution', command: 'write files' } })
    fs.writeFileSync(path.join(root, 'existing.txt'), 'after\n')
    fs.writeFileSync(path.join(root, 'created.txt'), 'new\n')
    fs.unlinkSync(path.join(root, 'removed.txt'))
    rpc(view, 'item/completed', { turnId: 't', item: { id: 'cmd', type: 'commandExecution', status: 'completed', exitCode: 0 } })
    rpc(view, 'turn/completed', { turnId: 't', turn: { id: 't', status: 'completed' } })
    assert.equal(posted.some(message => message.params?.item?.type === 'fileChange'), false)
    assert.ok(posted.some(message => message.params?.item?.type === 'commandExecution'))
    view.dispose()
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dynamic file tools create, replace and delete with precise diffs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-tools-'))
  try {
    assert.deepEqual(dynamicTools.map(tool => tool.name), ['write_file', 'replace_file_text', 'delete_file'])
    const created = editFile(root, 'write_file', { path: 'sub/a.txt', content: 'before\n' })
    assert.equal(created.kind, 'added')
    assert.match(created.diff, /\+before/)
    const changed = editFile(root, 'replace_file_text', { path: 'sub/a.txt', oldText: 'before', newText: 'after' })
    assert.equal(changed.kind, 'modified')
    assert.match(changed.diff, /-before\n\+after/)
    assert.equal(fs.readFileSync(path.join(root, 'sub/a.txt'), 'utf8'), 'after\n')
    const deleted = editFile(root, 'delete_file', { path: 'sub/a.txt' })
    assert.equal(deleted.kind, 'deleted')
    assert.match(deleted.diff, /\+\+\+ \/dev\/null/)
    assert.throws(() => editFile(root, 'write_file', { path: '../escape.txt', content: 'bad' }))
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
    assert.throws(() => editFile(root, 'write_file', { path: 'binary.bin', content: 'text' }), /二进制/)
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Codex dynamic tool call writes the file and emits a fileChange item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-tool-rpc-'))
  try {
    const { view, posted } = makeView(root)
    const responses = []
    view.client = { respond: (id, result) => responses.push({ id, result }), dispose() {} }
    view.busy = true
    view.permissionMode = 'auto'
    view.onCodexEvent({ type: 'rpc', message: { id: 41, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'write_file', arguments: { path: 'a.txt', content: 'hello\n' } } } })
    await tick()
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello\n')
    assert.equal(responses[0].id, 41)
    assert.equal(responses[0].result.success, true)
    assert.equal(posted.find(message => message.params?.item?.type === 'fileChange').params.item.changes[0].path, 'a.txt')
    view.dispose()
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('clicking an earlier edit opens its historical before and after in VS Code diff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-historical-diff-'))
  try {
    const { view, vscode } = makeView(root)
    const calls = []
    vscode.Uri = { from: value => value, file: value => ({ scheme: 'file', path: value }) }
    vscode.commands = { executeCommand: (...args) => calls.push(args) }
    const first = unifiedDiff('a.txt', 'one\n', 'two\n')
    const second = unifiedDiff('a.txt', 'two\n', 'three\n')
    fs.writeFileSync(path.join(root, 'a.txt'), 'three\n')
    rpc(view, 'item/completed', { turnId: 'turn', item: { id: 'first', type: 'fileChange', changes: [{ path: 'a.txt', diff: first }] } })
    rpc(view, 'item/completed', { turnId: 'turn', item: { id: 'second', type: 'fileChange', changes: [{ path: 'a.txt', diff: second }] } })
    await view.handle({ type: 'openDiff', path: 'a.txt', diff: first, turnId: 'turn', itemId: 'first', changeIndex: 0 })
    assert.equal(calls[0][0], 'vscode.diff')
    const beforeUri = calls[0][1], afterUri = calls[0][2]
    assert.equal(view.beforeDocuments.get(beforeUri.query), 'one\n')
    assert.equal(view.afterDocuments.get(afterUri.query), 'two\n')
    view.dispose()
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('text links open encoded absolute paths and reject paths outside workspace folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-links-'))
  const { view, vscode } = makeView(root)
  try {
    const opened = []
    vscode.workspace.openTextDocument = async file => { opened.push(file); return file }
    vscode.window.showTextDocument = async () => {}
    vscode.Range = class { constructor(...args) { this.args = args } }
    const file = path.join(root, 'new file.txt')
    const uri = require('node:url').pathToFileURL(file).href
    await view.handle({ type: 'openLink', href: `${uri}#L12` })
    await view.handle({ type: 'openLink', href: encodeURI(file) })
    await view.handle({ type: 'openFile', path: encodeURI(file) })
    fs.writeFileSync(file, 'test')
    await view.handle({ type: 'openLink', href: '/new%20file.txt' })
    assert.deepEqual(opened, [file, file, file, file])
    await assert.rejects(view.handle({ type: 'openFile', path: '../outside.txt' }), /不在当前工作区/)
    view.dispose()
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('CLI disconnect settles an active turn and the next request resumes its thread', async () => {
  const { view, posted } = makeView()
  view.conversation.begin('执行任务')
  view.busy = true
  view.onCodexEvent({ type: 'error', message: 'connection closed' })
  assert.equal(view.busy, false)
  assert.equal(view.conversation.turns.at(-1).status, 'failed')
  assert.equal(posted.find(message => message.type === 'history').snapshot.turns.at(-1).status, 'failed')
  const calls = []
  view.ensureClient = async () => ({ request: async method => { calls.push(method); return method === 'turn/start' ? { turn: { id: 'next' } } : {} } })
  await view.send('继续', 'm')
  assert.deepEqual(calls, ['thread/resume', 'turn/start'])
  rpc(view, 'turn/completed', { threadId: 'thread', turn: { id: 'next', status: 'completed' } })
  view.dispose()
})

test('summary panel combines all files and repeated edits into one turn diff', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-summary-diff-'))
  try {
    const { view, vscode } = makeView(root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'three\n')
    fs.writeFileSync(path.join(root, 'b.txt'), 'new\n')
    const first = unifiedDiff('a.txt', 'one\n', 'two\n')
    const second = unifiedDiff('a.txt', 'two\n', 'three\n')
    const other = unifiedDiff('b.txt', null, 'new\n')
    rpc(view, 'item/completed', { turnId: 'turn', item: { id: 'first', type: 'fileChange', changes: [{ path: 'a.txt', diff: first }] } })
    rpc(view, 'item/completed', { turnId: 'turn', item: { id: 'second', type: 'fileChange', changes: [{ path: 'a.txt', diff: second }, { path: 'b.txt', diff: other }] } })
    let receive, payload
    vscode.Uri = { file: file => ({ toString: () => file }) }
    vscode.ViewColumn = { One: 1 }
    vscode.window.createWebviewPanel = () => ({ webview: { cspSource: 'vscode-resource:', asWebviewUri: uri => uri, onDidReceiveMessage: callback => { receive = callback }, postMessage: value => { payload = value } } })
    view.openChanges('turn', 'a.txt')
    receive({ type: 'ready' })
    assert.equal(payload.type, 'changes')
    assert.equal(payload.selectedPath, 'a.txt')
    assert.match(payload.diff, /diff --git a\/a\.txt b\/a\.txt/)
    assert.match(payload.diff, /-one\n\+three/)
    assert.match(payload.diff, /diff --git a\/b\.txt b\/b\.txt/)
    view.dispose()
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('old threads are archived before a new tool-enabled thread starts', async () => {
  const { view } = makeView()
  view.dynamicToolsEnabled = false
  view.conversation.begin('旧任务')
  view.conversation.receive('turn/completed', { turn: { id: 'old', status: 'completed' } })
  const calls = []
  view.ensureClient = async () => ({ request: async (method, params) => {
    calls.push({ method, params })
    return method === 'thread/start' ? { thread: { id: 'new-thread' } } : { turn: { id: 'new-turn' } }
  } })
  await view.send('新任务', 'm')
  assert.equal(calls[0].method, 'thread/start')
  assert.deepEqual(calls[0].params.dynamicTools.map(tool => tool.name), dynamicTools.map(tool => tool.name))
  assert.ok(view.threads.some(thread => thread.id === 'thread' && thread.snapshot.turns[0].user === '旧任务'))
  assert.equal(view.threadId, 'new-thread')
  view.dispose()
})

test('Codex permission modes apply to each turn and full access needs explicit confirmation', async () => {
  const { view, vscode, posted } = makeView()
  const calls = []
  view.ensureClient = async () => ({ request: async (method, params) => { calls.push({ method, params }); return { turn: { id: 't' } } } })
  await view.send('查看项目', 'm')
  assert.deepEqual(calls.at(-1).params.sandboxPolicy, { type: 'readOnly' })
  view.busy = false
  await view.handle({ type: 'setPermissionMode', mode: 'auto' })
  await view.send('修改项目', 'm')
  assert.equal(calls.at(-1).params.sandboxPolicy.type, 'workspaceWrite')
  view.busy = false
  vscode.window.showWarningMessage = async () => undefined
  await view.handle({ type: 'setPermissionMode', mode: 'full' })
  assert.equal(view.permissionMode, 'auto')
  assert.equal(posted.at(-1).type, 'permissionModeRejected')
  vscode.window.showWarningMessage = async () => { throw new Error('dialog dismissed') }
  await view.handle({ type: 'setPermissionMode', mode: 'full' })
  assert.equal(view.permissionMode, 'auto')
  assert.equal(posted.at(-1).type, 'permissionModeRejected')
  vscode.window.showWarningMessage = async () => '启用完全访问'
  await view.handle({ type: 'setPermissionMode', mode: 'full' })
  await view.send('继续', 'm')
  assert.equal(calls.at(-1).params.approvalPolicy, 'never')
  assert.deepEqual(calls.at(-1).params.sandboxPolicy, { type: 'dangerFullAccess' })
  view.busy = false
  view.dispose()
})

test('new threads use the catalog and resumed threads replace saved base instructions with native text', async () => {
  for (const resume of [false, true]) {
    const { view } = makeView()
    if (resume) {
      view.loadedThreadId = null
      view.nativeInstructionsByModel = new Map([['m', 'Native Codex instructions']])
    }
    else view.threadId = null
    const calls = []
    view.ensureClient = async () => ({ request: async (method, params) => {
      calls.push({ method, params })
      return method === 'thread/start' ? { thread: { id: 'new-thread' } } : { turn: { id: 'turn' } }
    } })
    await view.send('检查指令', 'm')
    const threadCall = calls.find(call => call.method === (resume ? 'thread/resume' : 'thread/start'))
    assert.ok(threadCall)
    if (resume) assert.equal(threadCall.params.baseInstructions, 'Native Codex instructions')
    else assert.equal(Object.hasOwn(threadCall.params, 'baseInstructions'), false)
    view.dispose()
  }
})

test('user input server request responds to the current turn and clears on resolution or stop', async () => {
  const { view, posted } = makeView()
  const replies = []
  view.client = { respond: (id, body) => replies.push({ id, body }), request: async () => ({}), dispose() {} }
  view.busy = true
  view.turnId = 'turn'
  const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{ id: 'scope', header: '范围', question: '选哪个？', options: [{ label: '当前文件', description: '仅一个文件' }] }] }
  view.onCodexEvent({ type: 'rpc', message: { id: 42, method: 'item/tool/requestUserInput', params } })
  assert.equal(posted.at(-1).type, 'userInputRequest')
  await view.handle({ type: 'answerUserInput', id: '42', answers: { scope: { answers: ['当前文件', 'user_note: 保留 API'] } } })
  assert.deepEqual(replies, [{ id: 42, body: { answers: { scope: { answers: ['当前文件', 'user_note: 保留 API'] } } } }])
  assert.equal(view.busy, true)
  await view.handle({ type: 'answerUserInput', id: '42', answers: { scope: { answers: ['当前文件'] } } })
  assert.equal(replies.length, 1)
  rpc(view, 'serverRequest/resolved', { requestId: 42 })
  assert.equal(view.inputRequests.size, 0)
  view.onCodexEvent({ type: 'rpc', message: { id: 43, method: 'item/tool/requestUserInput', params } })
  await view.stop()
  view.recoverStoppedTurn()
  await tick()
  assert.equal(view.inputRequests.size, 0)
  assert.equal(posted.filter(message => message.type === 'state').at(-1).busy, false)
  assert.ok(posted.some(message => message.type === 'userInputsCleared'))
  view.dispose()
})

test('approval remains tracked until Codex resolves it and retries after a write error', async () => {
  const { view, posted } = makeView()
  const replies = []
  view.client = { respond: (id, body, done) => replies.push({ id, body, done }), dispose() {} }
  view.onCodexEvent({ type: 'rpc', message: { id: 77, method: 'item/commandExecution/requestApproval', params: { command: 'npm test', availableDecisions: ['accept', 'decline'] } } })
  await view.handle({ type: 'approve', id: '77', decision: 'accept' })
  assert.equal(view.approvals.size, 1)
  assert.equal(replies.length, 1)
  await view.handle({ type: 'approve', id: '77', decision: 'accept' })
  assert.equal(replies.length, 1)
  replies[0].done(new Error('write failed'))
  assert.equal(posted.at(-1).type, 'approvalError')
  await view.handle({ type: 'approve', id: '77', decision: 'accept' })
  assert.equal(replies.length, 2)
  replies[1].done()
  assert.equal(posted.at(-1).type, 'approvalSubmitted')
  rpc(view, 'serverRequest/resolved', { requestId: 77 })
  assert.equal(view.approvals.size, 0)
  view.dispose()
})

test('stop during turn/start uses turn/started id and allows follow-up in same thread', async () => {
  const { view, posted } = makeView()
  const calls = []
  let completeStart
  const client = {
    request(method, params) {
      calls.push({ method, params })
      if (method === 'turn/start' && calls.filter(call => call.method === 'turn/start').length === 1)
        return new Promise(resolve => { completeStart = resolve })
      if (method === 'turn/start') return Promise.resolve({ turn: { id: 't2' } })
      return Promise.resolve({})
    },
    dispose() {},
  }
  view.ensureClient = async () => { view.client = client; return client }
  const first = view.send('第一问', 'm')
  await tick()
  assert.equal(view.busy, true)
  assert.equal(view.turnId, null)
  await view.stop()
  assert.equal(view.stopping, true)
  rpc(view, 'turn/started', { threadId: 'thread', turn: { id: 't1', status: 'inProgress' } })
  await tick()
  assert.equal(calls.find(call => call.method === 'turn/interrupt').params.turnId, 't1')
  rpc(view, 'turn/completed', { threadId: 'thread', turnId: 't1', turn: { id: 't1', status: 'interrupted' } })
  completeStart({ turn: { id: 't1' } })
  await first
  assert.equal(view.busy, false)
  assert.equal(view.stopping, false)
  assert.equal(view.turnId, null)
  assert.equal(view.conversation.turns[0].status, 'interrupted')
  assert.equal(view.conversation.turns[0].stopRequested, true)
  assert.equal(posted.find(message => message.method === 'turn/completed').params.stopRequested, true)
  await view.send('第二问', 'm')
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2)
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 0)
  assert.equal(view.threadId, 'thread')
  rpc(view, 'turn/completed', { threadId: 'thread', turnId: 't2', turn: { id: 't2', status: 'completed' } })
  assert.equal(view.busy, false)
  assert.equal(view.conversation.turns.length, 2)
  await tick()
  assert.equal(posted.filter(message => message.type === 'state').at(-1).busy, false)
  view.dispose()
})

test('missing terminal notification resets connection and next turn resumes thread', async () => {
  const { view } = makeView()
  let disposed = false
  const firstClient = {
    request(method) { if (method === 'turn/start') return Promise.resolve({ turn: { id: 't1' } }); return new Promise(() => {}) },
    dispose() { disposed = true },
  }
  view.ensureClient = async () => { view.client = firstClient; return firstClient }
  await view.send('第一问', 'm')
  await view.stop()
  view.recoverStoppedTurn()
  assert.equal(disposed, true)
  assert.equal(view.busy, false)
  assert.equal(view.conversation.turns[0].status, 'interrupted')
  assert.equal(view.conversation.turns[0].stopRequested, true)
  const calls = []
  const secondClient = { request(method) { calls.push(method); return Promise.resolve(method === 'turn/start' ? { turn: { id: 't2' } } : {}) }, dispose() {} }
  view.ensureClient = async () => { view.client = secondClient; return secondClient }
  await view.send('继续', 'm')
  assert.deepEqual(calls, ['thread/resume', 'turn/start'])
  assert.equal(view.threadId, 'thread')
  rpc(view, 'turn/completed', { threadId: 'thread', turnId: 't2', turn: { id: 't2', status: 'completed' } })
  view.dispose()
})

test('normal completion permits another turn on the existing thread', async () => {
  const { view } = makeView()
  const calls = []
  const client = { request(method) { calls.push(method); return Promise.resolve({ turn: { id: `t${calls.filter(name => name === 'turn/start').length}` } }) }, dispose() {} }
  view.ensureClient = async () => { view.client = client; return client }
  await view.send('第一问', 'm')
  rpc(view, 'turn/completed', { threadId: 'thread', turnId: 't1', turn: { id: 't1', status: 'completed' } })
  await view.send('追问', 'm')
  rpc(view, 'turn/completed', { threadId: 'thread', turnId: 't2', turn: { id: 't2', status: 'completed' } })
  assert.deepEqual(calls, ['turn/start', 'turn/start'])
  assert.deepEqual(view.conversation.turns.map(turn => turn.user), ['第一问', '追问'])
  assert.equal(view.busy, false)
  view.dispose()
})

test('stop completes and permits another question when command output is null', async () => {
  const { view, posted } = makeView()
  const calls = []
  const client = { request(method) { calls.push(method); return Promise.resolve(method === 'turn/start' ? { turn: { id: 't2' } } : {}) }, dispose() {} }
  view.client = client
  view.conversation.begin('启动游戏')
  view.conversation.receive('turn/started', { threadId: 'thread', turn: { id: 't1', status: 'inProgress' } })
  view.conversation.receive('item/completed', { turnId: 't1', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: null } })
  view.busy = true
  view.turnId = 't1'
  await view.stop()
  rpc(view, 'turn/completed', { threadId: 'thread', turnId: 't1', turn: { id: 't1', status: 'interrupted' } })
  await tick()
  assert.equal(view.busy, false)
  assert.equal(view.stopping, false)
  assert.equal(posted.filter(message => message.type === 'state').at(-1).busy, false)
  view.ensureClient = async () => { view.client = client; return client }
  await view.send('继续修复', 'm')
  assert.equal(calls.includes('turn/start'), true)
  view.dispose()
})

test('stop timeout recovers even when previous command output was null', async () => {
  const { view, posted } = makeView()
  view.client = { request: async () => ({}), dispose() {} }
  view.conversation.begin('启动游戏')
  view.conversation.receive('turn/started', { threadId: 'thread', turn: { id: 't1', status: 'inProgress' } })
  view.conversation.receive('item/completed', { turnId: 't1', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: null } })
  view.busy = true
  view.turnId = 't1'
  await view.stop()
  view.recoverStoppedTurn()
  await tick()
  assert.equal(view.busy, false)
  assert.equal(view.conversation.turns[0].status, 'interrupted')
  assert.equal(posted.filter(message => message.type === 'stopped').length, 1)
  assert.equal(posted.filter(message => message.type === 'state').at(-1).busy, false)
  view.dispose()
})

test('idle state includes the terminal turn status for webview reconciliation', async () => {
  const { view, posted } = makeView()
  view.conversation.begin('运行命令')
  view.conversation.receive('turn/started', { threadId: 'thread', turn: { id: 't1', status: 'inProgress' } })
  view.conversation.receive('turn/completed', { turnId: 't1', turn: { id: 't1', status: 'interrupted' } })
  await view.postState()
  const state = posted.filter(message => message.type === 'state').at(-1)
  assert.equal(state.busy, false)
  assert.deepEqual(state.lastTurn, { id: 't1', status: 'interrupted', error: null })
  view.dispose()
})

test('account display uses a name claim rather than an employee identifier', async () => {
  const { view, posted } = makeView()
  const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  view.tokens = async () => ({ access_token: jwt({ id: '123456', name: '张三', email: 'user@example.com', picture: 'https://example.com/avatar.png' }), refresh_token: jwt({ id: '123456' }) })
  await view.postState()
  assert.deepEqual(posted.at(-1).user, { name: '张三', email: 'user@example.com', picture: 'https://example.com/avatar.png' })
  view.tokens = async () => ({ access_token: jwt({ id: '123456', name: '123456' }) })
  await view.postState()
  assert.equal(posted.at(-1).user.name, undefined)
  view.dispose()
})

test('image attachments are sent as image data in the model turn', async () => {
  const { view } = makeView()
  const calls = []
  view.ensureClient = async () => ({ request: async (method, params) => { calls.push({ method, params }); return { turn: { id: 'turn' } } } })
  const image = 'data:image/png;base64,aGVsbG8='
  await view.send('看看这张图', 'm', 'medium', [image])
  assert.deepEqual(calls.find(call => call.method === 'turn/start').params.input, [{ type: 'text', text: '看看这张图' }, { type: 'image', url: image }])
  view.dispose()
})

test('general file attachments provide text content and survive history restore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-attachment-'))
  const { view } = makeView(root)
  const attachment = { id: 'file-1', path: path.join(root, 'notes.txt'), name: 'notes.txt', kind: 'file', size: 5 }
  fs.writeFileSync(attachment.path, 'hello')
  view.attachmentRecords.set(attachment.id, attachment)
  let input
  view.ensureClient = async () => ({ request: async (method, params) => { if (method === 'turn/start') input = params.input; return { turn: { id: 't' } } } })
  try {
    await view.handle({ type: 'send', text: '', model: 'm', attachments: ['file-1'] })
    assert.ok(input.some(part => part.type === 'text' && part.text.includes('hello') && part.text.includes(attachment.path)))
    const snapshot = view.conversation.snapshot()
    view.conversation.restore(snapshot)
    assert.equal(view.conversation.turns.at(-1).attachments[0].name, 'notes.txt')
    await assert.rejects(view.handle({ type: 'send', model: 'm', attachments: ['unknown'] }), /附件不存在/)
  } finally { view.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('custom titles survive later history updates and skip automatic generation', async () => {
  const { view, posted } = makeView()
  view.conversation.begin('original prompt')
  view.persistHistory()
  await view.handle({ type: 'renameThread', threadId: 'thread', title: ' 我的任务 ' })
  assert.equal(view.threads[0].title, '我的任务')
  view.persistHistory()
  assert.equal(view.threads[0].title, '我的任务')
  assert.equal(view.threads[0].customTitle, true)
  let requested = false
  view.accessToken = async () => { requested = true; throw new Error('unexpected') }
  await view.maybeGenerateTitle('thread', 'm')
  assert.equal(requested, false)
  await assert.rejects(view.handle({ type: 'renameThread', threadId: 'thread', title: '  ' }), /标题需/)
  await assert.rejects(view.handle({ type: 'renameThread', threadId: 'missing', title: '名称' }), /会话不存在/)
  view.dispose()
})
