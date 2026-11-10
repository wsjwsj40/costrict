const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

test('Codex app-server starts with interactive input and plan tools enabled', async () => {
  const originalLoad = Module._load
  let spawned
  const writes = []
  const proc = new EventEmitter()
  proc.exitCode = null
  proc.killed = false
  proc.stdout = new EventEmitter()
  proc.stdout.setEncoding = () => {}
  proc.stderr = new EventEmitter()
  proc.stdin = { write(chunk, callback) {
    const message = JSON.parse(chunk)
    writes.push(message)
    callback?.()
    if (message.method === 'initialize') queueMicrotask(() => proc.stdout.emit('data', JSON.stringify({ id: message.id, result: {} }) + '\n'))
  } }
  proc.kill = () => { proc.killed = true }
  Module._load = function (name, parent, isMain) {
    if (name === 'vscode') return {}
    if (name === 'node:child_process') return { spawn: (...args) => { spawned = args; return proc } }
    return originalLoad.call(this, name, parent, isMain)
  }
  let CodexClient
  try { delete require.cache[require.resolve('../extension')]; ({ CodexClient } = require('../extension')) } finally { Module._load = originalLoad }
  const client = new CodexClient('/bin/codex', 'https://example.test/codex/v1', 'token', () => {})
  const [binary, args] = spawned
  assert.equal(binary, '/bin/codex')
  assert.equal(args[0], 'app-server')
  const overrides = args.flatMap((arg, index) => arg === '-c' ? [args[index + 1]] : [])
  assert.ok(overrides.includes('features.default_mode_request_user_input=true'))
  assert.ok(overrides.includes('tools.update_plan.enabled=true'))
  assert.ok(!overrides.some(override => override.startsWith('model_instructions_file=')))
  await client.initialize('0.2.8')
  assert.deepEqual(writes.map(message => message.method), ['initialize', 'initialized'])
  client.dispose()
})

test('Windows Codex prefers MXC and enables a legacy sandbox fallback', () => {
  const originalLoad = Module._load
  const proc = new EventEmitter()
  proc.exitCode = null; proc.killed = false
  proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {}
  proc.stderr = new EventEmitter()
  proc.stdin = { write() {} }
  proc.kill = () => { proc.killed = true }
  let args
  Module._load = function (name, parent, isMain) {
    if (name === 'vscode') return {}
    if (name === 'node:child_process') return { spawn: (_binary, options) => { args = options; return proc } }
    return originalLoad.call(this, name, parent, isMain)
  }
  let CodexClient
  try { delete require.cache[require.resolve('../extension')]; ({ CodexClient } = require('../extension')) } finally { Module._load = originalLoad }
  const client = new CodexClient('codex', 'https://example.test', 'token', () => {}, null, 'win32')
  assert.ok(args.includes('features.prefer_mxc=true'))
  assert.ok(args.includes('windows.sandbox="unelevated"'))
  client.dispose()
  const elevated = new CodexClient('codex', 'https://example.test', 'token', () => {}, null, 'win32', 'elevated')
  assert.ok(args.includes('windows.sandbox="elevated"'))
  elevated.dispose()
})
