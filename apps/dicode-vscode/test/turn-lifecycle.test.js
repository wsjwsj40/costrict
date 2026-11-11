const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { scanWorkspace } = require('../workspaceChanges')

function makeView(root = '/repo') {
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try { delete require.cache[require.resolve('../extension')]; ({ DicodeView } = require('../extension')) } finally { Module._load = originalLoad }
  const data = new Map([['dicodeCodex.thread', { id: 'thread', cwd: root }]])
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

test('shell writes create file edit events and diffs without Codex patch notifications', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-shell-edit-'))
  try {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'before\n')
    fs.writeFileSync(path.join(root, 'removed.txt'), 'gone\n')
    const { view, posted } = makeView(root)
    view.changeWorkspace = root
    view.changeSnapshot = scanWorkspace(root)
    rpc(view, 'turn/started', { turn: { id: 't' } })
    rpc(view, 'item/started', { turnId: 't', item: { id: 'cmd', type: 'commandExecution', command: 'write files' } })
    fs.writeFileSync(path.join(root, 'existing.txt'), 'after\n')
    fs.writeFileSync(path.join(root, 'created.txt'), 'new\n')
    fs.unlinkSync(path.join(root, 'removed.txt'))
    rpc(view, 'item/completed', { turnId: 't', item: { id: 'cmd', type: 'commandExecution', status: 'completed', exitCode: 0 } })
    const edit = posted.find(message => message.method === 'item/completed' && message.params?.item?.id?.startsWith('workspace-change-'))
    assert.ok(edit)
    assert.equal(edit.params.item.type, 'fileChange')
    assert.deepEqual(edit.params.item.changes.map(change => change.path).sort(), ['created.txt', 'existing.txt', 'removed.txt'])
    assert.match(edit.params.item.changes.find(change => change.path === 'existing.txt').diff, /-before\n\+after/)
    assert.match(edit.params.item.changes.find(change => change.path === 'created.txt').diff, /--- \/dev\/null/)
    assert.match(edit.params.item.changes.find(change => change.path === 'removed.txt').diff, /\+\+\+ \/dev\/null/)
    rpc(view, 'turn/completed', { turnId: 't', turn: { id: 't', status: 'completed' } })
    assert.equal(posted.filter(message => message.params?.item?.id?.startsWith('workspace-change-')).length, 1)
    view.dispose()
  } finally {
    if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true })
  }
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
