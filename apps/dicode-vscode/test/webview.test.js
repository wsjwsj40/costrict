const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'media/index.html'), 'utf8')
const bundle = fs.readFileSync(path.join(root, 'media/bundle.js'), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 50))
function setup() {
  const errors = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error))
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://dicode.local/', virtualConsole })
  const sent = []
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message), getState: () => ({}) })
  dom.window.eval(bundle)
  return { dom, sent, errors, doc: dom.window.document, emit: message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })) }
}
function typeInput(view, input, text) {
  // React 受控输入：jsdom 里必须用原生 setter 赋值，再派发 input 事件才会触发 onChange
  const setter = Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, text)
  input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }))
}
function item(id, type, raw = {}) { return { id, type, raw: { id, type, ...raw }, status: 'completed', text: raw.text || '', output: raw.aggregatedOutput || '' } }
async function display(view, items, status = 'inProgress', diff = '') {
  await tick()
  view.emit({ type: 'state', loggedIn: true, busy: status !== 'completed', workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  view.emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{ id: 'turn', user: '修改文件', status, startedAt: Date.now() - 1000, completedAt: status === 'completed' ? Date.now() : null, items, diff }] } })
  await tick()
}
test('React webview starts and uses VS Code theme tokens', async () => {
  const view = setup(); await display(view, [], 'completed')
  assert.equal(view.errors.length, 0)
  assert.ok(view.doc.querySelector('.composer'))
  assert.ok(view.sent.some(message => message.type === 'ready'))
  const css = fs.readFileSync(path.join(root, 'media/style.css'), 'utf8')
  assert.match(css, /--vscode-foreground/)
  assert.match(css, /--vscode-diffEditor-insertedLineBackground/)
  view.dom.window.close()
})
test('answer file links preserve absolute paths and task status changes after start', async () => {
  const view = setup(); await display(view, [item('answer', 'agentMessage', { text: '查看 /repo/目录/a.txt:12 和 [文件](file:///repo/%E7%9B%AE%E5%BD%95/a.txt)', phase: 'final_answer' })], 'completed')
  const links = view.doc.querySelectorAll('.final-answer a')
  links[0].click()
  assert.equal(view.sent.at(-1).path, '/repo/目录/a.txt:12')
  links[1].click()
  assert.equal(view.sent.at(-1).href, 'file:///repo/%E7%9B%AE%E5%BD%95/a.txt')
  view.emit({ type: 'rpc', method: 'turn/started', params: { turn: { id: 'next', status: 'inProgress' } } })
  await tick()
  assert.match(view.doc.querySelector('.status-line').textContent, /正在处理/)
  view.dom.window.close()
})
test('context menu displays live usage and requests real compaction', async () => {
  const view = setup(); await display(view, [], 'completed')
  view.emit({ type: 'state', loggedIn: true, busy: false, threadId: 'thread', permissionMode: 'request', models: [{ id: 'm', name: 'Model', contextWindow: 100000, maxTokens: 8192 }], tokenUsage: { modelId: 'm', modelContextWindow: 95000, last: { totalTokens: 27000, inputTokens: 25000, outputTokens: 2000, cachedInputTokens: 10000 } } })
  await tick()
  assert.match(view.doc.querySelector('.context-trigger').textContent, /27%/)
  view.doc.querySelector('.context-trigger').click(); await tick()
  assert.match(view.doc.querySelector('.context-menu').textContent, /27,000\s*\/\s*100,000/)
  assert.match(view.doc.querySelector('.context-menu').textContent, /8,192/)
  view.doc.querySelector('.compact-button').click()
  assert.equal(view.sent.at(-1).type, 'compactContext')
  view.dom.window.close()
})
test('empty model list exposes the loading failure and retry', async () => {
  const view = setup(); await display(view, [], 'completed')
  view.emit({ type: 'state', models: [], modelsError: '加载模型失败：offline' })
  await tick()
  view.doc.querySelector('.model-trigger').click(); await tick()
  assert.match(view.doc.querySelector('.model-menu').textContent, /offline/)
  view.doc.querySelector('.model-menu .model-option').click()
  assert.equal(view.sent.at(-1).type, 'models')
  view.dom.window.close()
})
test('compaction events appear in the active conversation', async () => {
  const view = setup()
  await display(view, [{ ...item('compact', 'contextCompaction'), status: 'inProgress' }])
  assert.match(view.doc.querySelector('.compact-event').textContent, /正在压缩上下文/)
  view.dom.window.close()
})
test('completed standalone compaction stays visible without a duration header', async () => {
  const view = setup(); await tick()
  view.emit({ type: 'state', loggedIn: true, busy: false, models: [{ id: 'm' }] })
  view.emit({ type: 'history', snapshot: { turns: [{ id: 'compact', user: '', status: 'completed', startedAt: 1000, completedAt: 3000, items: [item('event', 'contextCompaction')] }] } })
  await tick()
  assert.match(view.doc.querySelector('.compact-event').textContent, /已压缩上下文/)
  assert.equal(view.doc.querySelector('.process-toggle'), null)
  view.dom.window.close()
})
test('stopped and failed turns show distinct terminal descriptions even without activity', async () => {
  const view = setup(); await tick()
  view.emit({ type: 'state', loggedIn: true, busy: false, models: [{ id: 'm' }] })
  view.emit({ type: 'history', snapshot: { turns: [
    { id: 'stopped', user: 'a', status: 'interrupted', stopRequested: true, startedAt: 1000, completedAt: 16000, items: [] },
    { id: 'interrupted', user: 'b', status: 'interrupted', stopRequested: false, startedAt: 1000, completedAt: 6000, items: [] },
    { id: 'failed', user: 'c', status: 'failed', error: { message: '连接已断开' }, startedAt: 1000, completedAt: 4000, items: [] },
  ] } })
  await tick()
  const labels = [...view.doc.querySelectorAll('.process-toggle')].map(node => node.textContent)
  assert.match(labels[0], /你在15秒后停止了任务/)
  assert.match(labels[1], /意外中断/)
  assert.match(labels[2], /未能完成：连接已断开/)
  view.dom.window.close()
})
test('picker menus close on composer whitespace and their arrow follows expansion', async () => {
  const view = setup(); await display(view, [], 'completed')
  const trigger = view.doc.querySelector('.model-trigger')
  trigger.click(); await tick()
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.ok(trigger.querySelector('.model-chevron.expanded'))
  view.doc.querySelector('.composer textarea').dispatchEvent(new view.dom.window.MouseEvent('mousedown', { bubbles: true }))
  await tick()
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(trigger.querySelector('.model-chevron.expanded'), null)
  view.doc.querySelector('.permission-trigger').click(); await tick()
  view.doc.querySelector('.composer-spacer').dispatchEvent(new view.dom.window.MouseEvent('mousedown', { bubbles: true }))
  await tick()
  assert.equal(view.doc.querySelector('.permission-menu'), null)
  view.dom.window.close()
})
test('context indicator changes color at 25, 50, 75 and 90 percent', async () => {
  const view = setup(); await display(view, [], 'completed')
  for (const [used, expected] of [[24000, 'blue'], [25000, 'green'], [50000, 'yellow'], [75000, 'orange'], [90000, 'red']]) {
    view.emit({ type: 'state', models: [{ id: 'm', contextWindow: 100000 }], tokenUsage: { modelId: 'm', last: { totalTokens: used } } })
    await tick()
    assert.equal(view.doc.querySelector('.context-ring').dataset.level, expected)
  }
  view.emit({ type: 'state', tokenUsage: { modelId: 'm', last: { totalTokens: 120000 } } })
  await tick()
  assert.match(view.doc.querySelector('.context-trigger').textContent, /120%/)
  view.dom.window.close()
})
test('shell writes stay ordinary command rows with foldable output', async () => {
  const view = setup(); await display(view, [item('cmd', 'commandExecution', { command: 'pwsh -c "Set-Content a.txt done"', aggregatedOutput: 'done', exitCode: 0 })])
  const button = view.doc.querySelector('.command-activity .activity-toggle')
  assert.ok(button)
  assert.match(button.textContent, /Set-Content a\.txt/)
  assert.doesNotMatch(button.textContent, /pwsh|(?:^|\s)-c(?:\s|$)/i)
  assert.equal(view.doc.querySelector('.command-detail'), null)
  button.click(); await tick()
  assert.match(view.doc.querySelector('.command-detail').textContent, /done/)
  assert.doesNotMatch(view.doc.querySelector('.command-detail pre').textContent, /pwsh|(?:^|\s)-c(?:\s|$)/i)
  assert.equal(view.doc.querySelector('.file-activity'), null)
  view.dom.window.close()
})
test('portable PowerShell launcher is removed from command title and expanded command', async () => {
  const view = setup()
  const command = '& "C:\\Users\\Me\\AppData\\DiCode\\powershell\\package\\pwsh.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-ChildItem src | Select-Object Name"'
  await display(view, [item('cmd', 'commandExecution', { command, cwd: 'C:\\repo' })])
  const button = view.doc.querySelector('.command-activity .activity-toggle')
  assert.match(button.textContent, /Get-ChildItem src/)
  assert.doesNotMatch(button.textContent, /AppData|NoProfile|pwsh/)
  button.click(); await tick()
  assert.equal(view.doc.querySelector('.command-detail pre').textContent, 'Get-ChildItem src | Select-Object Name')
  assert.match(view.doc.querySelector('.detail-meta').textContent, /C:\\repo/)
  assert.doesNotMatch(view.doc.querySelector('.command-detail pre').textContent, /AppData|pwsh|NoProfile/)
  view.dom.window.close()
})
test('full VS Code storage path and -Command are hidden while cwd remains visible', async () => {
  const view = setup()
  const command = '"c:\\Users\\Example\\AppData\\Roaming\\Code\\User\\globalStorage\\atad-apts.dicode-codex\\powershell\\7.6.6-b4b1aff2e2b8\\package\\pwsh.exe" -Command \'Get-ChildItem -Name\''
  await display(view, [item('cmd', 'commandExecution', { command, cwd: 'C:\\workspaces\\project' })])
  const button = view.doc.querySelector('.command-activity .activity-toggle')
  assert.equal(button.textContent.trim(), '已运行 Get-ChildItem -Name')
  button.click(); await tick()
  assert.equal(view.doc.querySelector('.command-detail pre').textContent, 'Get-ChildItem -Name')
  assert.match(view.doc.querySelector('.detail-meta').textContent, /C:\\workspaces\\project/)
  view.dom.window.close()
})
test('nested Windows shell quoting also shows only the actual command', async () => {
  const view = setup()
  const command = 'cmd.exe /d /s /c ""C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-Location""'
  await display(view, [item('cmd', 'commandExecution', { command })])
  const button = view.doc.querySelector('.command-activity .activity-toggle')
  assert.match(button.textContent, /Get-Location/)
  assert.doesNotMatch(button.textContent, /Program Files|pwsh|NoProfile/)
  button.click(); await tick()
  assert.equal(view.doc.querySelector('.command-detail pre').textContent, 'Get-Location')
  view.dom.window.close()
})
test('dynamic edit renders a file row, inline diff and clickable filename', async () => {
  const view = setup()
  const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-before\n+after'
  await display(view, [item('edit', 'fileChange', { changes: [{ path: 'a.txt', kind: 'modified', diff }] })])
  const button = view.doc.querySelector('.file-activity .activity-toggle')
  assert.ok(button)
  assert.match(view.doc.querySelector('.activity-file-link').textContent, /a\.txt/)
  view.doc.querySelector('.activity-file-link').click()
  assert.equal(view.sent.at(-1).type, 'openDiff')
  assert.equal(view.doc.querySelector('.diff-line.added'), null)
  button.click(); await tick()
  assert.ok(view.doc.querySelector('.diff-line.added'))
  assert.ok(view.doc.querySelector('.diff-line.deleted'))
  view.doc.querySelector('.file-name').click()
  assert.equal(view.sent.at(-1).type, 'openDiff')
  assert.equal(view.sent.at(-1).path, 'a.txt')
  view.dom.window.close()
})
test('running turn has animated thinking and a visible duration', async () => {
  const view = setup(); await display(view, [item('reason', 'reasoning'), { ...item('cmd', 'commandExecution', { command: 'rg --files' }), status: 'inProgress' }])
  assert.equal(view.doc.querySelectorAll('.thinking').length, 1)
  assert.equal(view.doc.querySelector('.thinking').textContent, '正在思考')
  assert.ok(view.doc.querySelector('.command-activity .flowing'))
  assert.match(view.doc.querySelector('.process-toggle').textContent, /正在处理.*用时/)
  view.dom.window.close()
})
test('final file summary uses net diff, folds after three files and opens DiCode diff', async () => {
  const view = setup()
  const diff = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new`).join('\n')
  const events = ['a.txt', 'temporary.txt'].map((name, n) => item(`e${n}`, 'fileChange', { changes: [{ path: name, kind: 'added' }] }))
  await display(view, [...events, item('answer', 'agentMessage', { text: '已更新 a.txt', phase: 'final_answer' })], 'completed', diff)
  assert.equal(view.doc.querySelectorAll('.summary-file').length, 3)
  assert.match(view.doc.querySelector('.summary-title').textContent, /4 个文件/)
  assert.doesNotMatch(view.doc.querySelector('.file-summary').textContent, /temporary/)
  view.doc.querySelector('.summary-file').click()
  assert.equal(view.sent.at(-1).type, 'openChanges')
  assert.equal(view.sent.at(-1).selectedPath, 'a.txt')
  view.doc.querySelector('.summary-top').click()
  assert.equal(view.sent.at(-1).type, 'openChanges')
  view.doc.querySelector('.summary-more').click(); await tick()
  assert.equal(view.doc.querySelectorAll('.summary-file').length, 4)
  view.doc.querySelector('.final-answer .local-file-link').click()
  assert.equal(view.sent.at(-1).type, 'openFile')
  assert.equal(view.sent.at(-1).path, 'a.txt')
  view.dom.window.close()
})
test('created then deleted temporary file is absent when no final diff arrives', async () => {
  const view = setup()
  await display(view, [
    item('create', 'fileChange', { changes: [{ path: 'temporary.txt', kind: 'added' }] }),
    item('delete', 'fileChange', { changes: [{ path: 'temporary.txt', kind: 'deleted' }] }),
    item('keep', 'fileChange', { changes: [{ path: 'kept.txt', kind: 'added' }] }),
  ], 'completed')
  assert.equal(view.doc.querySelectorAll('.summary-file').length, 1)
  assert.equal(view.doc.querySelector('.summary-file-name').textContent, 'kept.txt')
  assert.match(view.doc.querySelector('.summary-title').textContent, /kept\.txt/)
  view.dom.window.close()
})
test('aggregate changes panel shows all files in one diff view', async () => {
  const page = html.replace('</head>', '<meta name="dicode-view" content="changes"></head>')
  const dom = new JSDOM(page, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://dicode.local/' })
  const sent = []
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) })
  dom.window.eval(bundle)
  await tick()
  assert.equal(sent[0].type, 'ready')
  const diff = ['a.txt', 'b.txt'].map(name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new`).join('\n')
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'changes', diff, selectedPath: 'b.txt' } }))
  await tick()
  assert.equal(dom.window.document.querySelectorAll('.changes-file').length, 2)
  assert.match(dom.window.document.querySelector('.changes-header').textContent, /2 个文件/)
  assert.equal(dom.window.document.querySelectorAll('.changes-file[open]').length, 1)
  assert.equal(dom.window.document.querySelector('.changes-file[open] .changes-file-title').textContent.includes('b.txt'), true)
  const summary = dom.window.document.querySelector('.changes-file summary')
  assert.ok(summary.querySelector('.changes-path + .chevron'))
  dom.window.document.querySelector('.changes-file summary').click()
  assert.equal(dom.window.document.querySelectorAll('.changes-file[open]').length, 2)
  dom.window.close()
})
test('completed process folds while final answer remains visible', async () => {
  const view = setup(); await display(view, [item('cmd', 'commandExecution', { command: 'rg --files' }), item('answer', 'agentMessage', { text: '完成', phase: 'final_answer' })], 'completed')
  assert.match(view.doc.querySelector('.final-answer').textContent, /完成/)
  assert.equal(view.doc.querySelector('.command-activity'), null)
  view.doc.querySelector('.process-toggle').click(); await tick()
  assert.ok(view.doc.querySelector('.command-activity'))
  view.dom.window.close()
})
test('user input choices return the selected answer to Codex', async () => {
  const view = setup(); await display(view, [])
  view.emit({ type: 'userInputRequest', id: 'request', params: { questions: [{ id: 'scope', question: '修改范围？', options: [{ label: '全部' }, { label: '当前文件' }] }] } })
  await tick()
  view.doc.querySelectorAll('.user-input-option input')[1].click(); await tick()
  view.doc.querySelector('.user-input-card .approval-actions button').click()
  assert.equal(view.sent.at(-1).type, 'answerUserInput')
  assert.equal(view.sent.at(-1).answers.scope.answers[0], '当前文件')
  view.dom.window.close()
})

test('selected image data is included when sending an image-only message', async () => {
  const view = setup(); await display(view, [], 'completed')
  const image = 'data:image/png;base64,aGVsbG8='
  view.emit({ type: 'imagesSelected', images: [{ path: '/tmp/image.png', name: 'image.png', data: image }] })
  await tick()
  view.doc.querySelector('.send-button').click()
  const sent = view.sent.findLast(message => message.type === 'send')
  assert.ok(sent)
  assert.deepEqual(Array.from(sent.images), [image])
  view.dom.window.close()
})

test('sent attachments remain visible and images open a preview', async () => {
  const view = setup(); await display(view, [], 'completed')
  view.emit({ type: 'history', snapshot: { turns: [{ id: 't', user: '', status: 'completed', items: [], attachments: [{ id: 'img', path: '/photo.png', name: 'photo.png', kind: 'image', src: 'data:image/png;base64,aGVsbG8=', size: 100 }, { id: 'doc', path: '/notes.txt', name: 'notes.txt', kind: 'file', size: 20 }] }] } })
  await tick()
  assert.equal(view.doc.querySelectorAll('.user-message .file-chip').length, 2)
  view.doc.querySelector('.user-message .file-chip-open').click(); await tick()
  assert.ok(view.doc.querySelector('[role="dialog"] img'))
  view.doc.querySelector('[aria-label="关闭预览"]').click(); await tick()
  view.doc.querySelectorAll('.user-message .file-chip-open')[1].click()
  assert.equal(view.sent.at(-1).type, 'openAttachment')
  assert.equal(view.sent.at(-1).id, 'doc')
  view.dom.window.close()
})

test('Markdown images preview before linked-image navigation and close with Escape', async () => {
  const view = setup()
  await display(view, [item('answer', 'agentMessage', { text: '[![截图](https://example.com/image.png)](https://example.com/page)\n\n[普通链接](https://example.com/help)', phase: 'final_answer' })], 'completed')
  const image = view.doc.querySelector('.final-answer img')
  assert.equal(image.getAttribute('role'), 'button')
  image.click(); await tick()
  assert.equal(view.doc.querySelector('[role="dialog"] img').src, 'https://example.com/image.png')
  assert.equal(view.sent.some(message => message.type === 'openLink'), false)
  view.doc.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick()
  assert.equal(view.doc.querySelector('[role="dialog"]'), null)
  view.doc.querySelectorAll('.final-answer a')[1].click()
  assert.equal(view.sent.at(-1).href, 'https://example.com/help')
  image.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick()
  assert.ok(view.doc.querySelector('[role="dialog"]'))
  view.dom.window.close()
})

test('history titles edit without opening the conversation and Escape cancels', async () => {
  const view = setup(); await display(view, [], 'completed')
  view.emit({ type: 'state', threads: [{ id: 'one', title: '旧标题', updatedAt: Date.now(), turns: [{ user: '问题', status: 'completed' }] }] })
  view.doc.querySelector('[title="历史会话"]').click(); await tick()
  view.doc.querySelector('.session-title').click(); await tick()
  assert.equal(view.sent.some(message => message.type === 'switchThread'), false)
  let input = view.doc.querySelector('[aria-label="会话标题"]')
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick()
  assert.equal(view.doc.querySelector('[aria-label="会话标题"]'), null)
  view.doc.querySelector('.session-title').click(); await tick()
  input = view.doc.querySelector('[aria-label="会话标题"]')
  const setter = Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '自定义标题'); input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await tick()
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick()
  const rename = view.sent.find(message => message.type === 'renameThread')
  assert.equal(rename.threadId, 'one'); assert.equal(rename.title, '自定义标题')
  view.dom.window.close()
})

// ---------------------------------------------------------------------------
// 【全部】市场页签（阶段 2）：引导、五态按钮、已安装标记、过期响应丢弃
// ---------------------------------------------------------------------------

const marketSkill = overrides => ({
  id: 'global/pdf-tools', namespace: 'global', slug: 'pdf-tools', name: 'PDF 工具',
  publisher: '张三', publisherDept: 'AI平台部', version: '', summary: '处理 PDF 的技能',
  tags: ['文档处理'], icon: 'data:image/png;base64,x', needApiKey: false,
  compat: 'compatible', downloadCount: 42, starCount: 3, ratingAvg: 4.5, ratingCount: 6, ...overrides,
})

/** 登录态进入市场页签并切到【全部】 */
async function enterMarket(view, { installed = [], loggedIn = true, baseUrlConfigured = true } = {}) {
  await tick()
  view.emit({ type: 'state', loggedIn, busy: false, workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  await tick()
  view.doc.querySelector('[aria-label="Skill 市场"]').click(); await tick()
  if (installed.length) view.emit({ type: 'installedSkills', skills: installed, indexAvailable: true, registryIgnored: true })
  await tick()
  const allTab = [...view.doc.querySelectorAll('.skill-tabs button')].find(node => node.textContent.includes('全部'))
  allTab.click(); await tick()
  view.emit({ type: 'marketAuthState', loggedIn, baseUrlConfigured })
  await tick()
}

test('market: compatible/incompatible/restricted render five-state buttons', async () => {
  const view = setup()
  await enterMarket(view)
  view.emit({ type: 'marketCatalog', items: [
    marketSkill({}),
    marketSkill({ id: 'g/legacy', slug: 'legacy', name: '旧版导出', compat: 'incompatible', minClientVersion: '1.5.0' }),
    marketSkill({ id: 'g/org', slug: 'org', name: '部门周报', compat: 'restricted', compatReason: '该部门未授权' }),
  ], page: 0, total: 3, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  const buttons = [...view.doc.querySelectorAll('.market-card .skill-actions button')]
  assert.deepEqual(buttons.map(node => node.textContent),
    ['安装', '不兼容', '已限制'])
  assert.equal(buttons[0].disabled, false)
  assert.equal(buttons[1].disabled, true)
  assert.match(view.doc.querySelector('.market-card:nth-child(2) .skill-actions').textContent, /1\.5\.0/)
  assert.match(view.doc.querySelector('.market-card:nth-child(3) .skill-actions').textContent, /该部门未授权/)
  buttons[0].click()
  assert.equal(view.sent.at(-1).type, 'marketInstall', '阶段 2 安装点击发 marketInstall')
  view.dom.window.close()
})

test('market: installed marker only counts market registry; same-name import shows note', async () => {
  const view = setup()
  const installed = [
    { dir: '.agents/skills/pdf-tools', dirPath: '/r/.agents/skills/pdf-tools', name: 'PDF 工具', summary: '', version: '1.0.0', source: 'market', installedAt: 1, enabled: true, scope: 'repo', path: null, missing: false, external: false, indexStale: false, altered: false, tags: [], record: { skillId: 'global/pdf-tools', source: 'market' } },
    { dir: '.agents/skills/demo', dirPath: '/r/.agents/skills/demo', name: 'demo', summary: '', version: null, source: 'import', installedAt: 1, enabled: true, scope: 'repo', path: null, missing: false, external: false, indexStale: false, altered: false, tags: [], record: { skillId: null, source: 'import' } },
  ]
  await enterMarket(view, { installed })
  view.emit({ type: 'marketCatalog', items: [
    marketSkill({}),
    marketSkill({ id: 'global/demo', slug: 'demo', name: 'demo', summary: '与本地导入同名的市场技能' }),
  ], page: 0, total: 2, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  const cards = [...view.doc.querySelectorAll('.market-card')]
  assert.ok(cards[0].querySelector('.source-tag.tone-market'), 'market 登记命中 → 已安装标签')
  assert.match(cards[0].querySelector('.skill-actions').textContent, /已安装/)
  assert.ok(!cards[1].querySelector('.source-tag.tone-market'), '同名导入不算已安装')
  assert.match(cards[1].querySelector('.skill-actions').textContent, /本地已有同名技能/)
  view.dom.window.close()
})

test('market: stale catalog response with outdated query is dropped', async () => {
  const view = setup()
  await enterMarket(view)
  const respond = (query, name) => view.emit({ type: 'marketCatalog', items: [marketSkill({ id: 'g/' + name, slug: name, name })], page: 0, total: 1, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query, label: '', sort: 'newest' })
  respond('', '初始项')
  await tick()
  const input = view.doc.querySelector('.installed-toolbar input')
  typeInput(view, input, 'pdf')
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.ok(view.sent.some(message => message.type === 'marketList' && message.query === 'pdf'), '防抖后下发服务端搜索')
  // 旧条件的响应先到（慢响应模拟）→ 必须被丢弃
  respond('', '过期项')
  await tick()
  assert.ok(!view.doc.body.textContent.includes('过期项'), '过期响应被丢弃')
  respond('pdf', '新项')
  await tick()
  assert.ok(view.doc.body.textContent.includes('新项'), '匹配当前条件的响应被接受')
  view.dom.window.close()
})

test('market: unconfigured base URL shows config gate, not an error', async () => {
  const view = setup()
  await enterMarket(view, { baseUrlConfigured: false })
  assert.match(view.doc.body.textContent, /市场服务未配置/)
  assert.ok(view.doc.body.textContent.includes('SKILLHUB_BASE_URL'))
  assert.ok(view.doc.body.textContent.includes('切到已安装'))
  view.dom.window.close()
})

test('market: logged-out shows login gate and submits marketLogin', async () => {
  const view = setup()
  await enterMarket(view, { loggedIn: false })
  assert.match(view.doc.body.textContent, /登录 SkillHub/)
  const inputs = [...view.doc.querySelectorAll('.market-gate input')]
  typeInput(view, inputs[0], 'admin')
  typeInput(view, inputs[1], 'admin123')
  await tick()
  view.doc.querySelector('.market-gate button[type="submit"]').click()
  const login = view.sent.filter(message => message.type === 'marketLogin').at(-1)
  assert.deepEqual({ username: login.username, password: login.password }, { username: 'admin', password: 'admin123' })
  view.dom.window.close()
})

test('market: tab switching keeps search text and installed list intact', async () => {
  const view = setup()
  await enterMarket(view)
  const installedSkill = { dir: '.agents/skills/example', dirPath: '/r/.agents/skills/example', name: 'example', summary: '', version: null, source: 'import', installedAt: 1, enabled: true, scope: 'repo', path: null, missing: false, external: false, indexStale: false, altered: false, tags: [], record: { skillId: null, source: 'import' } }
  view.emit({ type: 'installedSkills', skills: [installedSkill], indexAvailable: true, registryIgnored: true })
  await tick()
  view.emit({ type: 'marketCatalog', items: [marketSkill({})], page: 0, total: 1, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  typeInput(view, view.doc.querySelector('.installed-toolbar input'), '保留草稿')
  await tick()
  // 切回已安装再切回全部
  const tabs = () => [...view.doc.querySelectorAll('.skill-tabs button')]
  tabs().find(node => node.textContent.includes('已安装')).click(); await tick()
  assert.ok(view.doc.body.textContent.includes('example'), '已安装页签内容保留')
  tabs().find(node => node.textContent.includes('全部')).click(); await tick()
  assert.equal(view.doc.querySelector('.installed-toolbar input').value, '保留草稿', '【全部】搜索词保留')
  assert.ok(view.doc.body.textContent.includes('PDF 工具'), '【全部】列表保留')
  view.dom.window.close()
})

test('market: install click posts real marketInstall with skillId and version', async () => {
  const view = setup()
  await enterMarket(view)
  view.emit({ type: 'marketCatalog', items: [marketSkill({ version: '1.2.0' })], page: 0, total: 1, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  view.doc.querySelector('.market-card .skill-actions button').click()
  const install = view.sent.at(-1)
  assert.equal(install.type, 'marketInstall', '阶段 3 安装点击发 marketInstall')
  assert.equal(install.skillId, 'global/pdf-tools')
  assert.equal(install.version, '1.2.0')
  // 切到全部页签时先取任务快照（8.4 重连）
  assert.ok(view.sent.some(message => message.type === 'getInstallJobs'), '进入全部页签请求任务快照')
  view.dom.window.close()
})

test('market: install jobs drive card states with progress, retry and block', async () => {
  const view = setup()
  await enterMarket(view)
  view.emit({ type: 'marketCatalog', items: [
    marketSkill({}),
    marketSkill({ id: 'g/scraper', slug: 'scraper', name: '网页抓取' }),
    marketSkill({ id: 'g/heavy', slug: 'heavy', name: '超限用例' }),
  ], page: 0, total: 3, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  // 快照：一个在跑、一个失败可重试、一个失败不可重试
  view.emit({ type: 'installJobs', jobs: [
    { jobId: 'j1', skillId: 'global/pdf-tools', version: '1.2.0', state: 'downloading', seq: 2, progress: 40, retryable: false },
    { jobId: 'j2', skillId: 'g/scraper', version: '1.0.0', state: 'failed', seq: 3, errorCode: 'ARCHIVE_CORRUPT', errorMessage: '技能包校验失败', retryable: true },
    { jobId: 'j3', skillId: 'g/heavy', version: '1.0.0', state: 'failed', seq: 1, errorCode: 'ARCHIVE_TOO_LARGE', errorMessage: '超出大小限制', retryable: false },
  ] })
  await tick()
  const buttons = () => [...view.doc.querySelectorAll('.market-card .skill-actions button')]
  assert.equal(buttons()[0].textContent, '安装中…')
  assert.equal(buttons()[0].disabled, true)
  assert.match(view.doc.querySelectorAll('.market-card')[0].querySelector('.skill-actions').textContent, /下载 40%/)
  assert.equal(buttons()[1].textContent, '重试')
  assert.equal(buttons()[1].disabled, false)
  assert.match(view.doc.querySelectorAll('.market-card')[1].querySelector('.skill-actions').textContent, /技能包校验失败/, '重试态保留失败原因')
  assert.equal(buttons()[2].textContent, '无法安装')
  assert.equal(buttons()[2].disabled, true)

  // 进度事件推进：seq 递增生效
  view.emit({ type: 'installEvent', jobId: 'j1', skillId: 'global/pdf-tools', version: '1.2.0', state: 'downloading', seq: 3, progress: 85 })
  await tick()
  assert.match(view.doc.querySelectorAll('.market-card')[0].querySelector('.skill-actions').textContent, /下载 85%/)
  // 重复 seq 被忽略
  view.emit({ type: 'installEvent', jobId: 'j1', skillId: 'global/pdf-tools', version: '1.2.0', state: 'downloading', seq: 3, progress: 99 })
  await tick()
  assert.match(view.doc.querySelectorAll('.market-card')[0].querySelector('.skill-actions').textContent, /下载 85%/, '重复 seq 不生效')

  // 点击重试 → marketRetry 带旧 jobId
  buttons()[1].click()
  const retry = view.sent.at(-1)
  assert.equal(retry.type, 'marketRetry')
  assert.equal(retry.jobId, 'j2')

  // done 事件把任务移出，installedSkills 推送后卡片转已安装
  view.emit({ type: 'installEvent', jobId: 'j1', skillId: 'global/pdf-tools', version: '1.2.0', state: 'done', seq: 9 })
  view.emit({ type: 'installedSkills', skills: [{ dir: '.agents/skills/pdf-tools', dirPath: '/r/.agents/skills/pdf-tools', name: 'PDF 工具', summary: '', version: '1.2.0', source: 'market', installedAt: 1, enabled: true, scope: 'repo', path: null, missing: false, external: false, indexStale: false, altered: false, tags: [], record: { skillId: 'global/pdf-tools', source: 'market', version: '1.2.0' } }], indexAvailable: true, registryIgnored: true })
  await tick()
  assert.equal(buttons()[0].textContent, '已安装')
  assert.equal(buttons()[0].disabled, true)
  view.dom.window.close()
})

test('market: detail drawer shows update entry when registry version lags', async () => {
  const view = setup()
  const installed = [{ dir: '.agents/skills/pdf-tools', dirPath: '/r/.agents/skills/pdf-tools', name: 'PDF 工具', summary: '', version: '1.1.0', source: 'market', installedAt: 1, enabled: true, scope: 'repo', path: null, missing: false, external: false, indexStale: false, altered: false, tags: [], record: { skillId: 'global/pdf-tools', source: 'market', version: '1.1.0' } }]
  await enterMarket(view, { installed })
  view.emit({ type: 'marketCatalog', items: [marketSkill({ version: '1.2.0' })], page: 0, total: 1, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  const card = view.doc.querySelector('.market-card')
  assert.match(card.querySelector('.skill-actions').textContent, /已安装/, '已安装态')
  assert.match(card.querySelector('.skill-actions').textContent, /有 v1\.2\.0 可用/, '登记落后时附注更新提示')
  // 详情页更新入口
  view.doc.querySelector('.skill-name.as-link').click(); await tick()
  view.emit({ type: 'marketDetailResult', skillId: 'global/pdf-tools', skill: marketSkill({ version: '1.2.0' }), content: '# 概览', versions: [
    { version: '1.2.0', status: 'PUBLISHED', changelog: '新', fileCount: 1, totalSize: 1, publishedAt: Date.now(), downloadReady: true, createdByName: 'x' },
    { version: '1.1.0', status: 'PUBLISHED', changelog: '旧', fileCount: 1, totalSize: 1, publishedAt: Date.now(), downloadReady: true, createdByName: 'x' },
  ], version: '1.2.0' })
  await tick()
  const footer = view.doc.querySelector('.skill-detail-foot button')
  assert.match(footer.textContent, /更新到 v1\.2\.0/, '详情页更新入口')
  footer.click()
  const install = view.sent.at(-1)
  assert.equal(install.type, 'marketInstall')
  assert.equal(install.version, '1.2.0', '更新入口复用 marketInstall 传新版本')
  view.dom.window.close()
})

test('market: detail drawer renders versions and overview markdown', async () => {
  const view = setup()
  await enterMarket(view)
  view.emit({ type: 'marketCatalog', items: [marketSkill({})], page: 0, total: 1, hasNext: false, labelStats: [], cachedAt: Date.now(), stale: false, query: '', label: '', sort: 'newest' })
  await tick()
  view.doc.querySelector('.skill-name.as-link').click()
  assert.equal(view.sent.at(-1).type, 'marketDetail')
  assert.equal(view.sent.at(-1).skillId, 'global/pdf-tools')
  view.emit({ type: 'marketDetailResult', skillId: 'global/pdf-tools', skill: marketSkill({ version: '1.2.0' }), content: '# PDF 工具\n\n正文段落', versions: [
    { version: '1.2.0', status: 'PUBLISHED', changelog: '最新', fileCount: 5, totalSize: 102400, publishedAt: Date.now(), downloadReady: true, createdByName: '张三' },
    { version: '1.3.0', status: 'DRAFT', changelog: '草稿', fileCount: 5, totalSize: 102400, publishedAt: Date.now(), downloadReady: false, createdByName: '张三' },
  ], version: '1.2.0' })
  await tick()
  const drawer = view.doc.querySelector('.skill-detail')
  assert.ok(drawer, '详情抽屉打开')
  assert.match(drawer.textContent, /版本历史/)
  assert.match(drawer.querySelector('.markdown').textContent, /PDF 工具/)
  assert.match(drawer.textContent, /安装此版本 v1\.2\.0|安装此版本/)
  assert.match(drawer.textContent, /包未就绪|未发布/, 'DRAFT 版本不可安装')
  assert.match(drawer.textContent, /声明能力与示例暂无结构化数据/, '空态兜底（14 #16）')
  const versionBadge = [...view.doc.querySelectorAll('.market-card .skill-version')].at(-1)
  assert.match(versionBadge.textContent, /v1\.2\.0/, '详情打开后列表卡片版本回填（14 #15）')
  view.dom.window.close()
})
