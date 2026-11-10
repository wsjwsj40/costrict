const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'media/index.html'), 'utf8')
const bundle = fs.readFileSync(path.join(root, 'media/bundle.js'), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 45))
function setup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://dicode.local/' })
  const sent = []
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) })
  dom.window.eval(bundle)
  const emit = message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }))
  return { dom, sent, emit, doc: dom.window.document }
}
test('sidebar renders mixed app-server events and real approval decisions', async () => {
  const { dom, sent, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  doc.getElementById('prompt').value = '修复测试'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  assert.equal(sent.at(-1).type, 'send')
  emit({ type: 'rpc', method: 'turn/started', params: { threadId: 'thread', turn: { id: 't', status: 'inProgress' } } })
  emit({ type: 'rpc', method: 'item/started', params: { turnId: 't', item: { id: 'c', type: 'commandExecution', command: 'npm test', commandActions: [{ type: 'search' }], cwd: '/repo' } } })
  emit({ type: 'rpc', method: 'item/commandExecution/outputDelta', params: { turnId: 't', itemId: 'c', delta: 'ok\n' } })
  emit({ type: 'rpc', method: 'item/completed', params: { turnId: 't', item: { id: 'c', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'ok\n', exitCode: 0, durationMs: 12, status: 'completed' } } })
  emit({ type: 'rpc', method: 'turn/plan/updated', params: { turnId: 't', plan: [{ step: '运行测试', status: 'completed' }] } })
  emit({ type: 'rpc', method: 'turn/diff/updated', params: { turnId: 't', diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b' } })
  emit({ type: 'rpc', method: 'item/agentMessage/delta', params: { turnId: 't', itemId: 'a', delta: '# 完成\n`src/a.ts:12`\n```ts\nconst n = 1\n```\n<script>alert(1)</script>' } })
  await tick()
  assert.equal(doc.getElementById('planDock').hidden, false)
  assert.equal(doc.getElementById('planDock').nextElementSibling.id, 'changeDock')
  assert.equal(doc.getElementById('changeDock').nextElementSibling.className, 'composer-shell')
  assert.match(doc.getElementById('messages').textContent, /搜索代码/)
  assert.match(doc.getElementById('changeDock').textContent, /1 个文件已修改/)
  doc.querySelector('#changeDock .view-changes').click()
  assert.equal(sent.at(-1).type, 'openDiff')
  assert.equal(sent.at(-1).path, 'a.txt')
  assert.equal(doc.querySelectorAll('.plan-step').length, 0)
  assert.equal(doc.querySelectorAll('.code-block').length, 1)
  assert.equal(doc.querySelectorAll('#messages script').length, 0)
  assert.equal(doc.querySelectorAll('.file-ref').length, 1)
  doc.querySelector('.file-ref').click()
  assert.equal(sent.at(-1).type, 'openFile')
  assert.equal(sent.at(-1).path, 'src/a.ts:12')
  emit({ type: 'approval', id: '99', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: '需要在沙箱外执行', cwd: '/repo', availableDecisions: ['accept', 'decline'] } })
  assert.equal(doc.querySelectorAll('#approval button').length, 2)
  assert.match(doc.getElementById('approval').textContent, /原因：需要在沙箱外执行/)
  doc.querySelector('#approval .approval-accept').click()
  assert.equal(sent.at(-1).type, 'approve')
  assert.equal(sent.at(-1).id, '99')
  assert.equal(sent.at(-1).decision, 'accept')
  emit({ type: 'rpc', method: 'turn/completed', params: { turnId: 't', turn: { status: 'completed' } } })
  await tick()
  assert.equal(doc.getElementById('planDock').hidden, true)
  assert.equal(doc.getElementById('changeDock').hidden, true)
  assert.match(doc.querySelector('.turn-content > .file-summary').textContent, /a.txt/)
  assert.equal(doc.querySelectorAll('.turn').length, 1)
  dom.window.close()
})

test('completed turn folds muted activity behind elapsed time and keeps final answer separate', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: true, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', user: '修复问题', status: 'inProgress', startedAt: 1000, completedAt: null,
    plan: { steps: [{ step: '检查代码', status: 'inProgress' }, { step: '验证结果', status: 'pending' }] },
    items: [
      { id: 'cmd', type: 'commandExecution', status: 'completed', raw: { command: 'Get-ChildItem' }, output: 'file.txt' },
      { id: 'reason', type: 'reasoning', status: 'completed', summary: '检查代码结构', raw: {} },
      { id: 'note', type: 'agentMessage', status: 'completed', text: '正在检查', raw: { phase: 'commentary' } },
      { id: 'final', type: 'agentMessage', status: 'inProgress', text: '已修复', raw: { phase: 'final_answer' } },
    ],
  }] } })
  await tick()
  assert.equal(doc.getElementById('planDock').hidden, false)
  assert.match(doc.querySelector('.plan-dock-toggle').textContent, /检查代码/)
  assert.equal(doc.querySelectorAll('.plan-dock-toggle .plan-dock-title.plan-shimmer').length, 1)
  assert.equal(doc.getElementById('messages').textContent.includes('检查代码结构'), false)
  assert.equal(doc.querySelector('.turn-process').textContent.includes('执行计划'), false)
  doc.querySelector('.plan-dock-toggle').click()
  assert.equal(doc.querySelectorAll('.plan-dock-step').length, 2)
  assert.equal(doc.querySelectorAll('.plan-dock-step.inProgress .plan-step-text.plan-shimmer').length, 1)
  assert.equal(doc.querySelectorAll('.plan-dock-step.pending .plan-shimmer').length, 0)
  assert.equal(doc.querySelectorAll('.plan-wave-dot').length, 0)
  doc.querySelector('.plan-dock-toggle').click()
  emit({ type: 'rpc', method: 'turn/plan/updated', params: { turnId: 'turn', plan: [{ step: '检查代码', status: 'completed' }, { step: '验证结果', status: 'inProgress' }] } })
  await tick()
  assert.match(doc.querySelector('.plan-dock-toggle').textContent, /验证结果/)
  assert.equal(doc.querySelectorAll('.plan-dock-step').length, 0)
  assert.equal(doc.querySelector('.turn-process').open, true)
  emit({ type: 'rpc', method: 'turn/completed', params: { turnId: 'turn', turn: { id: 'turn', status: 'completed' } } })
  await tick()
  assert.equal(doc.getElementById('planDock').hidden, true)
  const process = doc.querySelector('.turn-process')
  assert.equal(process.open, false)
  assert.match(process.querySelector('summary').textContent, /^用时/)
  assert.match(process.textContent, /Get-ChildItem/)
  assert.equal(process.textContent.includes('检查代码结构'), false)
  assert.match(process.textContent, /正在检查/)
  assert.equal(doc.querySelectorAll('.turn-content > .final-answer').length, 1)
  assert.equal(doc.querySelector('.turn-content > .final-answer').textContent.includes('已修复'), true)
  assert.equal(doc.querySelectorAll('.turn-content > .commentary-answer').length, 0)
  dom.window.close()
})

test('consecutive commands share a collapsible list and retain their output', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', user: '查看项目', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [
      { id: 'one', type: 'commandExecution', status: 'completed', raw: { command: 'Get-ChildItem', commandActions: [{ type: 'list' }] }, output: 'README.md' },
      { id: 'two', type: 'commandExecution', status: 'completed', raw: { command: 'Get-Content README.md' }, output: 'project' },
      { id: 'answer', type: 'agentMessage', status: 'completed', text: '已查看', raw: { phase: 'final_answer' } },
    ],
  }] } })
  await tick()
  const group = doc.querySelector('.command-group')
  assert.ok(group)
  assert.equal(group.open, false)
  assert.match(group.querySelector('summary').textContent, /已读取文件 1 次、已列出文件 1 次/)
  assert.equal(group.querySelectorAll('.command-card').length, 2)
  assert.ok(group.querySelector('.command-group-icon svg'))
  assert.ok(group.querySelector('.command-card .activity-icon svg'))
  assert.equal(group.querySelector('.command-group-icon svg path').getAttribute('d'), group.querySelector('.command-card .activity-icon svg path').getAttribute('d'))
  assert.match(group.textContent, /Get-Content README\.md/)
  assert.match(group.textContent, /README\.md/)
  assert.equal(doc.querySelector('.turn-process').open, false)
  dom.window.close()
})

test('four consecutive commands stay in one group across pending and invisible events', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: true, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'inProgress', startedAt: Date.now() - 1000,
    items: [
      { id: 'one', type: 'commandExecution', status: 'completed', raw: { command: 'pwd' } },
      { id: 'output', type: 'functionCallOutput', status: 'completed', raw: {} },
      { id: 'two', type: 'commandExecution', status: 'completed', raw: { command: 'ls' } },
      { id: 'reason', type: 'reasoning', status: 'completed', raw: {} },
      { id: 'three', type: 'commandExecution', status: 'inProgress', raw: { command: 'npm test' } },
      { id: 'four', type: 'commandExecution', status: 'inProgress', raw: { command: 'git status' } },
    ],
  }] } })
  await tick()
  const groups = doc.querySelectorAll('.command-group')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].querySelectorAll('.command-card').length, 4)
  assert.equal(groups[0].open, true)
  assert.match(groups[0].querySelector('.command-group-label').textContent, /正在执行 4 条命令/)
  dom.window.close()
})

test('PowerShell file reads group with adjacent commands across empty commentary', async () => {
  const { dom, emit, doc } = setup()
  const read = String.raw`"c:\Users\wang.shijie11\AppData\Roaming\Code\pwsh.exe" -Command '$c = Get-Content -LiteralPath "D:\projects\test\game.js"; 70..160 | ForEach-Object { "$($_+1): $($c[$_])" }'`
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [
      { id: 'one', type: 'commandExecution', status: 'completed', raw: { command: read } },
      { id: 'empty', type: 'agentMessage', status: 'completed', text: '', raw: { phase: 'commentary' } },
      { id: 'two', type: 'commandExecution', status: 'completed', raw: { command: 'npm test' } },
    ],
  }] } })
  await tick()
  const group = doc.querySelector('.command-group')
  assert.ok(group)
  assert.equal(group.querySelectorAll('.command-card').length, 2)
  assert.match(group.querySelector('.command-group-label').textContent, /已执行 1 条命令、已读取文件 1 次/)
  assert.match(group.querySelector('.command-card summary').textContent, /已读取文件/)
  assert.doesNotMatch(group.querySelector('.command-card summary').textContent, /已搜索代码/)
  dom.window.close()
})

test('structured command actions take priority over command text when rendering', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [
      { id: 'read', type: 'commandExecution', status: 'completed', raw: { command: 'rg something', commandActions: [{ type: 'read', path: 'game.js' }] } },
      { id: 'list', type: 'commandExecution', status: 'completed', raw: { command: 'rg something', commandActions: [{ type: 'listFiles' }] } },
      { id: 'search', type: 'commandExecution', status: 'completed', raw: { command: 'Get-Content game.js | Select-String needle', commandActions: [{ type: 'read' }, { type: 'search' }] } },
    ],
  }] } })
  await tick()
  const cards = doc.querySelectorAll('.command-card')
  assert.match(cards[0].querySelector('.activity-label').textContent, /已读取文件/)
  assert.match(cards[1].querySelector('.activity-label').textContent, /已列出文件/)
  assert.match(cards[2].querySelector('.activity-label').textContent, /已搜索代码/)
  assert.match(doc.querySelector('.command-group-label').textContent, /已搜索代码 1 次、已读取文件 1 次、已列出文件 1 次/)
  dom.window.close()
})

test('shell edits show detected file changes when Codex emits only a diff', async () => {
  const { dom, emit, doc } = setup()
  const diff = 'diff --git a/game.js b/game.js\n--- a/game.js\n+++ b/game.js\n@@ -1 +1 @@\n-old\n+new'
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000, diff,
    items: [
      { id: 'one', type: 'commandExecution', status: 'completed', raw: { command: 'Get-Content game.js' } },
      { id: 'two', type: 'commandExecution', status: 'completed', raw: { command: 'Set-Content game.js new' } },
      { id: 'final', type: 'agentMessage', status: 'completed', text: '完成', raw: { phase: 'final_answer' } },
    ],
  }] } })
  await tick()
  const group = doc.querySelector('.command-group')
  assert.ok(group)
  assert.equal(group.querySelectorAll('.command-card').length, 2)
  assert.equal(group.querySelectorAll('.file-card').length, 1)
  assert.match(group.querySelector('.file-card summary').textContent, /检测到文件变更 · game\.js/)
  assert.match(group.querySelector('.command-group-label').textContent, /已编辑 1 个文件、已执行 1 条命令、已读取文件 1 次/)
  dom.window.close()
})

test('visible commentary separates adjacent activity groups', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [
      { id: 'one', type: 'commandExecution', status: 'completed', raw: { command: 'pwd' } },
      { id: 'two', type: 'commandExecution', status: 'completed', raw: { command: 'ls' } },
      { id: 'note', type: 'agentMessage', status: 'completed', text: '继续检查', raw: { phase: 'commentary' } },
      { id: 'three', type: 'commandExecution', status: 'completed', raw: { command: 'npm test' } },
      { id: 'four', type: 'commandExecution', status: 'completed', raw: { command: 'git status' } },
    ],
  }] } })
  await tick()
  const groups = doc.querySelectorAll('.command-group')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].querySelectorAll('.command-card').length, 2)
  assert.equal(groups[1].querySelectorAll('.command-card').length, 2)
  assert.match(groups[0].nextElementSibling.textContent, /继续检查/)
  dom.window.close()
})

test('running commands shimmer, editing shows changes, and completion keeps a file list', async () => {
  const { dom, sent, emit, doc } = setup()
  const diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new'
  emit({ type: 'state', loggedIn: true, busy: true, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', user: '修改文件', status: 'inProgress', startedAt: Date.now() - 5000, diff,
    items: [
      { id: 'done', type: 'commandExecution', status: 'completed', raw: { command: 'rg --files' }, output: 'src/a.js' },
      { id: 'running', type: 'commandExecution', status: 'inProgress', raw: { command: 'npm test' }, output: '' },
      { id: 'edit', type: 'fileChange', status: 'inProgress', raw: { changes: [{ path: 'src/a.js', diff }] } },
    ],
  }] } })
  await tick()
  assert.match(doc.querySelector('.turn-process-summary').textContent, /^正在处理/)
  assert.equal(doc.querySelector('.command-group').open, true)
  assert.match(doc.querySelector('.command-group-label').textContent, /正在编辑 1 个文件、正在执行 1 条命令、已列出文件 1 次/)
  assert.match(doc.querySelector('.command-card.status-completed').textContent, /rg --files/)
  assert.match(doc.querySelector('.command-card.status-inProgress').textContent, /正在运行 npm test/)
  assert.equal(doc.querySelectorAll('.command-card.status-inProgress .running-shimmer').length, 1)
  assert.match(doc.querySelector('.file-card.status-inProgress').textContent, /正在编辑文件/)
  assert.equal(doc.getElementById('changeDock').hidden, false)
  doc.querySelector('#changeDock .view-changes').click()
  assert.equal(sent.at(-1).type, 'openDiff')
  assert.equal(sent.at(-1).path, 'src/a.js')
  emit({ type: 'rpc', method: 'item/completed', params: { turnId: 'turn', item: { id: 'running', type: 'commandExecution', status: 'completed', command: 'npm test' } } })
  emit({ type: 'rpc', method: 'item/completed', params: { turnId: 'turn', item: { id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: 'src/a.js', diff }] } } })
  emit({ type: 'rpc', method: 'turn/completed', params: { turnId: 'turn', turn: { id: 'turn', status: 'completed' } } })
  await tick()
  assert.equal(doc.querySelectorAll('.running-shimmer').length, 0)
  assert.equal(doc.getElementById('changeDock').hidden, true)
  assert.match(doc.querySelector('.turn-content > .file-summary').textContent, /src\/a.js/)
  doc.querySelector('.file-summary-row').click()
  assert.equal(sent.at(-1).type, 'openDiff')
  dom.window.close()
})

test('mixed edits and commands use a content-based group with separate file rows', async () => {
  const { dom, emit, doc } = setup()
  const diff = path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [
      { id: 'edit', type: 'fileChange', status: 'completed', raw: { changes: [{ path: 'a.js', diff: diff('a.js') }, { path: 'b.js', diff: diff('b.js') }] } },
      { id: 'command', type: 'commandExecution', status: 'completed', raw: { command: 'npm test' }, output: 'ok' },
    ],
  }] } })
  await tick()
  const group = doc.querySelector('.command-group')
  assert.match(group.querySelector('.command-group-label').textContent, /已编辑 2 个文件、已执行 1 条命令/)
  assert.equal(group.querySelectorAll('.file-card').length, 2)
  assert.equal(group.querySelectorAll('.command-card').length, 1)
  assert.match(group.querySelector('.file-card').textContent, /a\.js \+1 -1/)
  assert.ok(group.querySelector('.file-card .activity-icon svg'))
  assert.ok(group.querySelector('.command-card .activity-icon svg'))
  dom.window.close()
})

test('a single search activity renders directly without a redundant group', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [{ id: 'search', type: 'commandExecution', status: 'completed', raw: { command: 'rg login', commandActions: [{ type: 'search' }] }, output: 'login.js' }],
  }] } })
  await tick()
  assert.equal(doc.querySelector('.command-group'), null)
  assert.equal(doc.querySelectorAll('.command-card').length, 1)
  assert.match(doc.querySelector('.command-card summary').textContent, /已搜索代码 rg login/)
  dom.window.close()
})

test('local rg search is labelled as search even when Codex omits command actions', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [{
    id: 'turn', status: 'completed', startedAt: 1000, completedAt: 3000,
    items: [
      { id: 'search', type: 'commandExecution', status: 'completed', raw: { command: 'rg -n login src' }, output: 'src/a.js:1:login' },
      { id: 'build', type: 'commandExecution', status: 'completed', raw: { command: 'npm run build' }, output: 'ok' },
    ],
  }] } })
  await tick()
  assert.match(doc.querySelector('.command-group-label').textContent, /已搜索代码 1 次/)
  assert.match(doc.querySelector('.command-group-label').textContent, /已执行 1 条命令/)
  assert.match(doc.querySelector('.command-card summary').textContent, /已搜索代码 rg -n login src/)
  dom.window.close()
})

test('command headings keep full single-line text for responsive CSS clipping while details keep original commands', async () => {
  const { dom, emit, doc } = setup()
  const longCommand = `rg --files ${'src/very-long-directory/'.repeat(5)}`
  const multilineCommand = 'npm test\n-- --runInBand'
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [
    { id: 'single', status: 'completed', startedAt: 1000, completedAt: 2000, items: [{ id: 'one', type: 'commandExecution', status: 'completed', raw: { command: multilineCommand } }] },
    { id: 'grouped', status: 'completed', startedAt: 3000, completedAt: 4000, items: [
      { id: 'two', type: 'commandExecution', status: 'completed', raw: { command: longCommand } },
      { id: 'three', type: 'commandExecution', status: 'completed', raw: { command: 'pwd' } },
    ] },
  ] } })
  await tick()
  const single = doc.querySelector('[data-turn-id="single"] .command-card')
  assert.equal(single.querySelector('.activity-label').textContent, '已运行 npm test -- --runInBand')
  assert.equal(single.querySelector('.command-text').textContent, multilineCommand)
  const grouped = doc.querySelector('[data-turn-id="grouped"] .command-card')
  assert.equal(grouped.querySelector('.activity-label').textContent, `已列出文件 ${longCommand}`)
  assert.equal(grouped.querySelector('.command-text').textContent, longCommand)
  dom.window.close()
})

test('recent threads can be selected and history replaces the visible conversation', async () => {
  const { dom, sent, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, threadId: 'one', workspace: '/repo', models: [], threads: [{ id: 'two', title: '修复登录' }, { id: 'one', title: '分析接口' }] })
  doc.getElementById('threadsButton').click()
  assert.equal(doc.querySelectorAll('.thread-entry').length, 2)
  doc.querySelector('.thread-entry').click()
  assert.equal(sent.at(-1).type, 'switchThread')
  assert.equal(sent.at(-1).threadId, 'two')
  emit({ type: 'history', snapshot: { threadId: 'two', turns: [{ id: 't', user: '修复登录', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: '已修复', raw: { phase: 'final_answer' }, status: 'completed' }] }] } })
  await tick()
  assert.equal(doc.querySelectorAll('.turn').length, 1)
  assert.match(doc.getElementById('messages').textContent, /已修复/)
  dom.window.close()
})

test('permission selector follows host state and sends mode changes', () => {
  const { dom, sent, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, permissionMode: 'auto', models: [] })
  const selector = doc.getElementById('permissionMode')
  assert.equal(selector.value, 'auto')
  doc.getElementById('permissionPicker').click()
  assert.equal(doc.querySelectorAll('.permission-option').length, 3)
  doc.querySelector('.permission-option[data-mode="full"]').click()
  assert.equal(sent.at(-1).type, 'setPermissionMode')
  assert.equal(sent.at(-1).mode, 'full')
  emit({ type: 'permissionModeRejected', mode: 'auto' })
  assert.equal(selector.value, 'auto')
  assert.equal(doc.getElementById('permissionLabel').textContent, '自动授权')
  dom.window.close()
})

test('model picker and stop state let the user continue after interruption', async () => {
  const { dom, sent, emit, doc } = setup()
  emit({ type: 'state', version: 1, loggedIn: true, busy: false, threadId: 'thread', workspace: '/repo', models: [{ id: 'm1', name: '快速模型' }, { id: 'm2', name: '推理模型' }] })
  doc.getElementById('modelPicker').click()
  assert.equal(doc.getElementById('modelMenu').hidden, false)
  doc.querySelectorAll('.model-option')[1].click()
  assert.equal(doc.getElementById('modelLabel').textContent, '推理模型')
  assert.equal(doc.getElementById('modelPicker').title, '推理模型')
  doc.getElementById('prompt').value = '第一问'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  assert.equal(sent.at(-1).model, 'm2')
  emit({ type: 'state', version: 2, loggedIn: true, busy: true, stopping: false, threadId: 'thread', workspace: '/repo', models: [{ id: 'm1', name: '快速模型' }, { id: 'm2', name: '推理模型' }] })
  assert.equal(doc.getElementById('stop').hidden, false)
  doc.getElementById('stop').click()
  assert.equal(sent.at(-1).type, 'stop')
  assert.equal(doc.getElementById('stop').hidden, true)
  assert.equal(doc.getElementById('stopping').hidden, false)
  emit({ type: 'state', version: 3, loggedIn: true, busy: true, stopping: true, threadId: 'thread', workspace: '/repo', models: [{ id: 'm1', name: '快速模型' }, { id: 'm2', name: '推理模型' }] })
  emit({ type: 'rpc', method: 'turn/completed', params: { threadId: 'thread', turnId: 't1', turn: { id: 't1', status: 'interrupted' } } })
  emit({ type: 'state', version: 4, loggedIn: true, busy: false, stopping: false, threadId: 'thread', workspace: '/repo', models: [{ id: 'm1', name: '快速模型' }, { id: 'm2', name: '推理模型' }] })
  await tick()
  assert.equal(doc.getElementById('send').hidden, false)
  assert.equal(doc.getElementById('stop').hidden, true)
  assert.match(doc.getElementById('status').textContent, /已停止/)
  doc.getElementById('prompt').value = '继续问答'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  assert.equal(sent.at(-1).type, 'send')
  assert.equal(sent.at(-1).text, '继续问答')
  assert.equal(doc.querySelectorAll('.turn').length, 2)
  dom.window.close()
})

test('model picker filters longer lists without changing the selected model', () => {
  const { dom, emit, doc } = setup()
  const models = Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, name: `模型 ${index}` }))
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models })
  doc.getElementById('modelPicker').click()
  const search = doc.querySelector('.model-search')
  assert.ok(search)
  search.value = '模型 6'
  search.dispatchEvent(new dom.window.Event('input'))
  assert.equal([...doc.querySelectorAll('.model-option')].filter(option => !option.hidden).length, 1)
  assert.equal(doc.getElementById('model').value, 'm0')
  dom.window.close()
})

test('picker menus stay inside a narrow sidebar and reposition on resize', () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: false, workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  Object.defineProperty(doc.documentElement, 'clientWidth', { configurable: true, value: 220 })
  Object.defineProperty(doc.documentElement, 'clientHeight', { configurable: true, value: 300 })
  const permissionPicker = doc.getElementById('permissionPicker')
  const modelPicker = doc.getElementById('modelPicker')
  const permissionMenu = doc.getElementById('permissionMenu')
  const modelMenu = doc.getElementById('modelMenu')
  permissionPicker.getBoundingClientRect = () => ({ left: 10, right: 110, top: 260, bottom: 289 })
  modelPicker.getBoundingClientRect = () => ({ left: 145, right: 205, top: 260, bottom: 289 })
  Object.defineProperty(permissionMenu, 'scrollHeight', { configurable: true, value: 190 })
  Object.defineProperty(modelMenu, 'scrollHeight', { configurable: true, value: 220 })
  modelMenu.getBoundingClientRect = () => ({ width: 150 })
  permissionPicker.click()
  assert.equal(permissionMenu.style.width, '204px')
  assert.equal(permissionMenu.style.left, '8px')
  assert.equal(permissionMenu.style.top, '63px')
  modelPicker.click()
  assert.equal(permissionMenu.hidden, true)
  assert.equal(modelMenu.style.width, 'max-content')
  assert.equal(modelMenu.style.left, '55px')
  assert.equal(modelMenu.style.top, '33px')
  Object.defineProperty(doc.documentElement, 'clientWidth', { configurable: true, value: 280 })
  dom.window.dispatchEvent(new dom.window.Event('resize'))
  assert.equal(modelMenu.style.width, 'max-content')
  assert.equal(modelMenu.style.left, '55px')
  dom.window.close()
})

test('streaming follows the bottom until the user scrolls up, and recent prompt jumps to its message', async () => {
  const { dom, emit, doc } = setup()
  const list = doc.getElementById('messages')
  let height = 1000
  Object.defineProperty(list, 'scrollHeight', { get: () => height })
  Object.defineProperty(list, 'clientHeight', { get: () => 200 })
  let scrolledTo = null
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolledTo = { node: this, options } }
  emit({ type: 'state', loggedIn: true, workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  doc.getElementById('prompt').value = '第一问，请检查登录'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  assert.equal(list.scrollTop, height)
  assert.equal(doc.getElementById('recentPrompt').hidden, false)
  assert.match(doc.getElementById('recentPromptText').textContent, /第一问/)
  emit({ type: 'rpc', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: '分析中' } })
  height = 1500
  await tick()
  assert.equal(list.scrollTop, height)
  list.scrollTop = 100
  list.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 }))
  list.dispatchEvent(new dom.window.Event('scroll'))
  height = 1800
  emit({ type: 'rpc', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: '更多内容' } })
  await tick()
  assert.equal(list.scrollTop, 100)
  assert.equal(doc.getElementById('backToBottom').hidden, false)
  assert.equal(doc.getElementById('backToBottom').getAttribute('aria-label'), '回到底部')
  assert.equal(doc.getElementById('backToBottom').textContent, '↓')
  doc.getElementById('recentPrompt').click()
  assert.equal(scrolledTo.node.className, 'user-message')
  assert.equal(scrolledTo.options.block, 'start')
  doc.getElementById('backToBottom').click()
  assert.equal(list.scrollTop, height)
  assert.equal(doc.getElementById('backToBottom').hidden, true)
  dom.window.close()
})

test('pinned prompt reflects the user turn above the current viewport', async () => {
  const { dom, emit, doc } = setup()
  const list = doc.getElementById('messages')
  Object.defineProperty(list, 'scrollHeight', { get: () => 2000 })
  Object.defineProperty(list, 'clientHeight', { get: () => 200 })
  list.getBoundingClientRect = () => ({ top: 100 })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (!this.classList.contains('user-message')) return { top: 0 }
    return { top: 100 + [...list.querySelectorAll('.user-message')].indexOf(this) * 400 - list.scrollTop }
  }
  emit({ type: 'state', loggedIn: true, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: [1, 2, 3, 4].map(n => ({ id: `t${n}`, user: `第${n}条输入`, items: [], status: 'completed' })) } })
  await tick()
  list.scrollTop = 500
  list.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 }))
  list.dispatchEvent(new dom.window.Event('scroll'))
  assert.equal(doc.getElementById('recentPromptText').textContent, '第2条输入')
  // The jump puts the second question 12px below the list's top edge.
  list.scrollTop = 388
  list.dispatchEvent(new dom.window.Event('scroll'))
  assert.equal(doc.getElementById('recentPromptText').textContent, '第2条输入')
  list.scrollTop = 900
  list.dispatchEvent(new dom.window.Event('scroll'))
  assert.equal(doc.getElementById('recentPromptText').textContent, '第3条输入')
  list.scrollTop = 1500
  list.dispatchEvent(new dom.window.Event('scroll'))
  assert.equal(doc.getElementById('recentPromptText').textContent, '第4条输入')
  dom.window.close()
})

test('user input request offers choices and custom text, then resumes the same turn', () => {
  const { dom, sent, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: true, workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [
    { id: 'scope', header: '范围', question: '修改哪些文件？', options: [{ label: '全部', description: '修改所有相关文件' }, { label: '当前文件', description: '只改当前文件' }] },
    { id: 'detail', header: '要求', question: '还有其他要求吗？', options: [] },
  ] }
  emit({ type: 'userInputRequest', id: 'req-1', params })
  assert.equal(doc.getElementById('userInput').hidden, false)
  assert.match(doc.getElementById('userInput').textContent, /修改哪些文件/)
  doc.querySelectorAll('.user-input-question')[0].querySelectorAll('.user-input-option input')[1].click()
  assert.equal(doc.querySelectorAll('.user-input-question')[0].querySelector('.user-input-field').hidden, true)
  doc.querySelectorAll('.user-input-note')[0].value = '不要改测试'
  doc.querySelector('.user-input-actions button').click()
  assert.equal(sent.at(-1).type, 'ready')
  assert.match(doc.querySelector('.user-input-error').textContent, /请输入自定义回答/)
  doc.querySelectorAll('.user-input-custom')[1].value = '保留现有 API'
  doc.querySelector('.user-input-actions button').click()
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'answerUserInput', id: 'req-1', answers: {
    scope: { answers: ['当前文件', 'user_note: 不要改测试'] },
    detail: { answers: ['user_note: 保留现有 API'] },
  } })
  assert.equal(doc.getElementById('stop').hidden, false)
  emit({ type: 'rpc', method: 'serverRequest/resolved', params: { requestId: 'req-1' } })
  assert.equal(doc.getElementById('userInput').hidden, true)
  dom.window.close()
})

test('user can switch from a selected option to a custom answer without sending the old note', () => {
  const { dom, sent, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, busy: true, workspace: '/repo', models: [{ id: 'm', name: 'Model' }] })
  emit({ type: 'userInputRequest', id: 'req-custom', params: { questions: [{ id: 'style', header: '风格', question: '选择风格', options: [{ label: '简洁', description: '少量装饰' }, { label: '丰富', description: '更多装饰' }] }] } })
  const section = doc.querySelector('.user-input-question')
  const radios = section.querySelectorAll('.user-input-option input')
  const custom = section.querySelector('.user-input-custom')
  const note = section.querySelector('.user-input-note')
  radios[0].click()
  note.value = '偏蓝'
  radios[2].click()
  assert.equal(radios[0].checked, false)
  assert.equal(section.querySelectorAll('.user-input-field')[0].hidden, false)
  assert.equal(section.querySelectorAll('.user-input-field')[1].hidden, true)
  doc.querySelector('.user-input-actions button').click()
  assert.match(doc.querySelector('.user-input-error').textContent, /请输入自定义回答/)
  custom.value = '用自然绿色'
  doc.querySelector('.user-input-actions button').click()
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1).answers)), { style: { answers: ['user_note: 用自然绿色'] } })
  dom.window.close()
})

test('long conversations show a recent window and load older turns on demand', async () => {
  const { dom, emit, doc } = setup()
  emit({ type: 'state', loggedIn: true, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: Array.from({ length: 35 }, (_, i) => ({ id: `t${i}`, user: `输入${i}`, items: [], status: 'completed' })) } })
  await tick()
  assert.equal(doc.querySelectorAll('.turn').length, 30)
  doc.querySelector('.show-earlier').click()
  assert.equal(doc.querySelectorAll('.turn').length, 35)
  assert.equal(doc.querySelector('.show-earlier'), null)
  dom.window.close()
})

test('a paused reader keeps the same visible turns when a new turn arrives', async () => {
  const { dom, emit, doc } = setup()
  const list = doc.getElementById('messages')
  Object.defineProperty(list, 'scrollHeight', { get: () => 3000 })
  Object.defineProperty(list, 'clientHeight', { get: () => 200 })
  emit({ type: 'state', loggedIn: true, workspace: '/repo', models: [] })
  emit({ type: 'history', snapshot: { threadId: 'thread', turns: Array.from({ length: 31 }, (_, i) => ({ id: `t${i}`, user: `输入${i}`, items: [], status: 'completed' })) } })
  await tick()
  assert.equal(doc.querySelector('.turn').dataset.turnId, 't1')
  list.scrollTop = 300
  list.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 }))
  list.dispatchEvent(new dom.window.Event('scroll'))
  emit({ type: 'rpc', method: 'turn/started', params: { threadId: 'thread', turn: { id: 't31', status: 'inProgress' } } })
  await tick()
  assert.equal(doc.querySelector('.turn').dataset.turnId, 't1')
  assert.equal(list.scrollTop, 300)
  dom.window.close()
})

test('host idle state clears the working badge after cancelling command approval', async () => {
  const { dom, sent, emit, doc } = setup()
  const state = (version, busy, lastTurn) => emit({ type: 'state', version, loggedIn: true, busy, workspace: '/repo', models: [{ id: 'm', name: 'Model' }], lastTurn })
  state(1, false, null)
  doc.getElementById('prompt').value = '运行命令'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  emit({ type: 'rpc', method: 'turn/started', params: { threadId: 'thread', turn: { id: 't1', status: 'inProgress' } } })
  state(2, true, { id: 't1', status: 'inProgress' })
  emit({ type: 'approval', id: 'a1', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', availableDecisions: ['accept', 'cancel'] } })
  await tick()
  assert.match(doc.getElementById('messages').textContent, /正在处理/)
  Array.from(doc.querySelectorAll('#approval button')).find(button => button.textContent === '取消').click()
  assert.equal(sent.at(-1).decision, 'cancel')
  state(3, false, { id: 't1', status: 'interrupted' })
  await tick()
  assert.doesNotMatch(doc.getElementById('messages').textContent, /正在处理/)
  assert.match(doc.getElementById('messages').textContent, /已停止/)
  assert.equal(doc.getElementById('send').hidden, false)
  doc.getElementById('prompt').value = '换个方法'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  assert.equal(sent.at(-1).type, 'send')
  assert.equal(doc.querySelectorAll('.working').length, 1)
  dom.window.close()
})

test('host idle state clears the working badge after stop even without a turn notification', async () => {
  const { dom, emit, doc } = setup()
  const state = (version, busy, lastTurn, stopping = false) => emit({ type: 'state', version, loggedIn: true, busy, stopping, workspace: '/repo', models: [{ id: 'm', name: 'Model' }], lastTurn })
  state(1, false, null)
  doc.getElementById('prompt').value = '执行任务'
  doc.getElementById('prompt').dispatchEvent(new dom.window.Event('input'))
  doc.getElementById('send').click()
  emit({ type: 'rpc', method: 'turn/started', params: { threadId: 'thread', turn: { id: 't1', status: 'inProgress' } } })
  state(2, true, { id: 't1', status: 'inProgress' })
  doc.getElementById('stop').click()
  state(3, true, { id: 't1', status: 'inProgress' }, true)
  await tick()
  assert.match(doc.getElementById('messages').textContent, /正在停止/)
  state(4, false, { id: 't1', status: 'interrupted' })
  await tick()
  assert.doesNotMatch(doc.getElementById('messages').textContent, /正在处理|正在停止/)
  assert.equal(doc.getElementById('stop').hidden, true)
  assert.equal(doc.getElementById('send').hidden, false)
  dom.window.close()
})
