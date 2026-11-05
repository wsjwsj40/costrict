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
