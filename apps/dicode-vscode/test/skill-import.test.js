const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

test('imports a local skill, refreshes Codex, and does not overwrite existing files', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-skill-test-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const workspace = path.join(temp, 'workspace')
  const source = path.join(temp, 'example')
  await fs.mkdir(workspace); await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: example\ndescription: Useful skill\n---\nInstructions')
  await fs.mkdir(path.join(source, 'references'))
  await fs.writeFile(path.join(source, 'references', 'guide.md'), 'guide')
  const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] }, window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showOpenDialog: async () => [{ fsPath: source }] } }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try { ({ DicodeView } = require('../extension')) } finally { Module._load = originalLoad }
  const context = { extensionPath: path.join(__dirname, '..'), globalState: { get: (_, fallback) => fallback, update: async () => {} }, secrets: { get: async () => null } }
  const view = new DicodeView(context)
  const messages = []; const calls = []
  view.post = message => messages.push(message)
  view.ensureClient = async () => ({ request: async (method, params) => { calls.push({ method, params }); return { data: [{ skills: [{ name: 'example' }], errors: [] }] } } })
  await view.handle({ type: 'importSkill' })
  assert.equal(messages.at(-1).type, 'skills', messages.at(-1).message)
  const dest = path.join(workspace, '.agents', 'skills', 'example')
  assert.equal(await fs.readFile(path.join(dest, 'references', 'guide.md'), 'utf8'), 'guide')
  assert.equal(calls[0].method, 'skills/list')
  assert.equal(calls[0].params.forceReload, true)
  assert.equal(messages.at(-1).type, 'skills')
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: example\ndescription: Changed\n---\nChanged')
  await view.handle({ type: 'importSkill' })
  assert.match(messages.at(-1).message, /已存在/)
  assert.match(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), /Useful skill/)
  view.dispose()
})
