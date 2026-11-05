const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

function makeView() {
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: '/repo' } }] },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try { ({ DicodeView } = require('../extension')) } finally { Module._load = originalLoad }
  const data = new Map([['dicodeCodex.thread', { id: 'thread', cwd: '/repo' }]])
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
  return { view, posted }
}
function rpc(view, method, params) { view.onCodexEvent({ type: 'rpc', message: { method, params } }) }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

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
