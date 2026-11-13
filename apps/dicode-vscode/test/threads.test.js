const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

test('new thread retains recent sessions and switching restores selected snapshot', async () => {
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try { ({ DicodeView } = require('../extension')) } finally { Module._load = originalLoad }
  const data = new Map([
    ['dicodeCodex.thread', { id: 'two', cwd: '/repo' }],
    ['dicodeCodex.threads', [
      { id: 'one', cwd: '/repo', title: '第一轮', snapshot: { threadId: 'one', turns: [{ id: 't1', user: '第一轮', status: 'completed', items: [] }] } },
      { id: 'two', cwd: '/repo', title: '第二轮', snapshot: { threadId: 'two', turns: [{ id: 't2', user: '第二轮', status: 'completed', items: [] }] } },
    ]],
  ])
  const context = {
    extensionPath: path.join(__dirname, '..'),
    globalState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => { data.set(key, value) } },
    secrets: { get: async () => null },
  }
  const view = new DicodeView(context)
  view.view = { webview: { postMessage() {} } }
  await view.handle({ type: 'newThread' })
  assert.equal(view.threadId, null)
  assert.equal(view.threads.length, 2)
  await view.handle({ type: 'switchThread', threadId: 'one' })
  assert.equal(view.threadId, 'one')
  assert.equal(view.conversation.turns[0].user, '第一轮')
  assert.equal(data.get('dicodeCodex.thread').id, 'one')
  view.dispose()
})

test('background conversations remain isolated, notify, and respect the three-run limit', async () => {
  const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] }, window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) } }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView, ConversationCoordinator
  try { ({ DicodeView, ConversationCoordinator } = require('../extension')) } finally { Module._load = originalLoad }
  const data = new Map()
  const context = { extensionPath: path.join(__dirname, '..'), globalState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => { data.set(key, value) } }, secrets: { get: async () => null } }
  const first = new DicodeView(context)
  first.view = { webview: { postMessage() {} } }
  const manager = new ConversationCoordinator(first)
  first.threadId = 'one'; first.busy = true; first.conversation.begin('one')
  await manager.handle({ type: 'newThread' })
  const second = manager.active
  assert.notEqual(second, first)
  assert.equal(first.busy, true)
  second.threadId = 'two'; second.busy = true; second.conversation.begin('two')
  await manager.handle({ type: 'newThread' })
  const third = manager.active
  third.threadId = 'three'; third.busy = true; third.conversation.begin('three')
  await assert.rejects(manager.handle({ type: 'newThread' }), /三个会话/)
  first.post({ type: 'userInputRequest', id: '1' })
  assert.equal(manager.unread.has('one'), true)
  await manager.handle({ type: 'switchThread', threadId: 'one' })
  assert.equal(manager.active, first)
  assert.equal(manager.unread.has('one'), false)
  assert.equal(first.conversation.turns[0].user, 'one')
  assert.equal(third.busy, true)
  manager.dispose()
  first.coordinator = null
  first.dispose()
})
