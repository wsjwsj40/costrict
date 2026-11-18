const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const archive = require('../skillArchive')

const SKILL = (name, description = '测试技能') => `---\nname: ${name}\ndescription: ${description}\n---\n\n步骤\n`

/** 最小 ZIP（仅 store），够验证导入链路 */
function makeZip(entries) {
  const locals = []; const centrals = []; let offset = 0
  for (const spec of entries) {
    const raw = Buffer.from(spec.data || '')
    const name = Buffer.from(spec.name, 'utf8')
    const crc = archive.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
    locals.push(local, name, raw)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + raw.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/**
 * 造一个可驱动的 DicodeView：文件对话框、弹窗选择、技能索引全部可注入。
 */
async function setup(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-skill-test-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const workspace = path.join(temp, 'workspace')
  await fs.mkdir(workspace)
  const state = {
    dialog: options.dialog || [],
    warnings: [],
    warningChoice: options.warningChoice || '取消',
    inputName: options.inputName || 'renamed',
    deleted: [],
    commands: [],
    indexEnabled: options.indexEnabled !== false,
  }
  const vscode = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      fs: { delete: async (uri, opts) => state.deleted.push({ path: uri.fsPath, opts }) },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showOpenDialog: async () => state.dialog,
      showQuickPick: async () => ({ label: '从文件夹导入', value: 'folder' }),
      showWarningMessage: async (message, opts, first) => {
        state.warnings.push({ message, first })
        return typeof state.warningChoice === 'function' ? state.warningChoice(message) : state.warningChoice
      },
      showInputBox: async () => state.inputName,
    },
    Uri: { file: value => ({ fsPath: value }) },
    commands: { executeCommand: async (...args) => state.commands.push(args) },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try {
    // 每个用例都要拿到绑定自己 vscode 桩的实例，必须先清掉模块缓存
    delete require.cache[require.resolve('../extension')]
    ;({ DicodeView } = require('../extension'))
  } finally { Module._load = originalLoad }

  const context = { extensionPath: path.join(__dirname, '..'), globalState: { get: (_, fallback) => fallback, update: async () => {} }, secrets: { get: async () => null } }
  const view = new DicodeView(context)
  const messages = []; const requests = []
  view.post = message => messages.push(message)
  let authCalls = 0
  view.accessToken = async () => { authCalls += 1; throw new Error('请先登录') }
  view.ensureClient = async () => { authCalls += 1; throw new Error('请先登录') }
  view.ensureSkillClient = async () => ({
    request: async (method, params) => {
      requests.push({ method, params })
      if (method === 'skills/config/write') return { data: {} }
      if (!state.indexEnabled) throw new Error('codex 不可用')
      const skillsRoot = path.join(workspace, '.agents', 'skills')
      const entries = await fs.readdir(skillsRoot).catch(() => [])
      return { data: [{ skills: entries.filter(name => !name.startsWith('.')).map(dir => ({ name: dir, description: dir, path: path.join(skillsRoot, dir, 'SKILL.md'), enabled: true, scope: 'repo' })), errors: [] }] }
    },
  })
  t.after(() => view.dispose())
  return { view, messages, requests, state, workspace, temp, skillsRoot: path.join(workspace, '.agents', 'skills'), authCalls: () => authCalls }
}

async function makeSource(temp, name = 'example', description = 'Useful skill') {
  const source = path.join(temp, name)
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), SKILL(name, description))
  await fs.mkdir(path.join(source, 'references'), { recursive: true })
  await fs.writeFile(path.join(source, 'references', 'guide.md'), 'guide')
  return source
}

const registryOf = async workspace => JSON.parse(await fs.readFile(path.join(workspace, '.agents/skills.registry.json'), 'utf8')).skills

test('文件夹导入写入登记并强制刷新索引', async t => {
  const source = await makeSource(path.join(os.tmpdir(), 'dicode-skill-src-' + Date.now()))
  t.after(() => fs.rm(source, { recursive: true, force: true }))
  const ctx = await setup(t, { dialog: [{ fsPath: source }] })
  await ctx.view.handle({ type: 'importSkill', mode: 'folder' })
  const dest = path.join(ctx.skillsRoot, 'example')
  assert.equal(await fs.readFile(path.join(dest, 'references/guide.md'), 'utf8'), 'guide')
  assert.equal(ctx.messages.at(-1).type, 'skillImported')
  const records = await registryOf(ctx.workspace)
  assert.equal(records.length, 1)
  assert.equal(records[0].source, 'import')
  assert.equal(records[0].version, '0.0.0-local')
  assert.equal(records[0].dir, '.agents/skills/example')
  assert.match(records[0].dirDigest, /^sha256:/)
  assert.ok(ctx.requests.some(item => item.method === 'skills/list' && item.params.forceReload === true))
  assert.equal(ctx.authCalls(), 0, '导入不应触发登录')
})

test('同名导入：覆盖替换内容，重命名装到新目录，取消不动现场', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-skill-src-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const source = await makeSource(temp, 'example', '第一版')

  const overwrite = await setup(t, { dialog: [{ fsPath: source }], warningChoice: '覆盖' })
  await overwrite.view.handle({ type: 'importSkill', mode: 'folder' })
  await fs.writeFile(path.join(source, 'SKILL.md'), SKILL('example', '第二版'))
  await overwrite.view.handle({ type: 'importSkill', mode: 'folder' })
  assert.match(await fs.readFile(path.join(overwrite.skillsRoot, 'example/SKILL.md'), 'utf8'), /第二版/)
  assert.equal((await registryOf(overwrite.workspace)).length, 1)

  const rename = await setup(t, { dialog: [{ fsPath: source }], warningChoice: '重命名', inputName: 'example-copy' })
  await rename.view.handle({ type: 'importSkill', mode: 'folder' })
  await rename.view.handle({ type: 'importSkill', mode: 'folder' })
  assert.equal(await fs.stat(path.join(rename.skillsRoot, 'example-copy/SKILL.md')).then(() => true, () => false), true)

  const cancel = await setup(t, { dialog: [{ fsPath: source }], warningChoice: '覆盖' })
  await cancel.view.handle({ type: 'importSkill', mode: 'folder' })
  await fs.writeFile(path.join(source, 'SKILL.md'), SKILL('example', '取消不该生效'))
  cancel.state.warningChoice = '取消'
  await cancel.view.handle({ type: 'importSkill', mode: 'folder' })
  assert.match(await fs.readFile(path.join(cancel.skillsRoot, 'example/SKILL.md'), 'utf8'), /第二版/)
  assert.equal((await registryOf(cancel.workspace)).length, 1)
})

test('目标目录是市场安装项时阻断，不写登记不动文件', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-skill-src-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const source = await makeSource(temp, 'demo', '本地版本')
  const ctx = await setup(t, { dialog: [{ fsPath: source }], warningChoice: '覆盖' })
  await fs.mkdir(path.join(ctx.workspace, '.agents'), { recursive: true })
  await fs.writeFile(path.join(ctx.workspace, '.agents/skills.registry.json'), JSON.stringify({ version: 1, skills: [{ skillId: 'ns/demo', source: 'market', name: '演示', version: '1.2.0', dir: '.agents/skills/demo', installedAt: 1, dirDigest: 'sha256:x' }] }))
  await fs.mkdir(path.join(ctx.skillsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(ctx.skillsRoot, 'demo/SKILL.md'), SKILL('市场版', '市场'))

  await ctx.view.handle({ type: 'importSkill', mode: 'folder' })
  const last = ctx.messages.at(-1)
  assert.equal(last.type, 'skillsError')
  assert.equal(last.code, 'DIR_CONFLICT')
  assert.match(last.message, /市场管理/)
  assert.match(await fs.readFile(path.join(ctx.skillsRoot, 'demo/SKILL.md'), 'utf8'), /市场版/)
  assert.equal((await registryOf(ctx.workspace)).length, 1)
  assert.equal((await fs.readdir(ctx.skillsRoot)).filter(name => name.startsWith('.tmp-')).length, 0)
})

test('ZIP 导入：单层根目录被剥离，路径穿越被拒绝', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-skill-zip-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const good = path.join(temp, 'good.zip')
  await fs.writeFile(good, makeZip([{ name: 'pkg/SKILL.md', data: SKILL('压缩技能') }, { name: 'pkg/run.md', data: '步骤' }]))
  const ctx = await setup(t, { dialog: [{ fsPath: good }] })
  await ctx.view.handle({ type: 'importSkill', mode: 'zip' })
  assert.equal(await fs.readFile(path.join(ctx.skillsRoot, 'pkg/run.md'), 'utf8'), '步骤')

  const bad = path.join(temp, 'bad.zip')
  await fs.writeFile(bad, makeZip([{ name: '../evil.txt', data: 'x' }, { name: 'pkg/SKILL.md', data: SKILL('坏包') }]))
  const badCtx = await setup(t, { dialog: [{ fsPath: bad }] })
  await badCtx.view.handle({ type: 'importSkill', mode: 'zip' })
  assert.equal(badCtx.messages.at(-1).type, 'skillsError')
  assert.equal(badCtx.messages.at(-1).code, 'ARCHIVE_INVALID')
  assert.equal((await fs.readdir(badCtx.skillsRoot)).filter(name => name.startsWith('.tmp-')).length, 0)
})

test('重新导入继承 skillId 与 source；内容与登记不符时拒绝并保留旧登记', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-skill-reimport-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const source = await makeSource(temp, 'demo', '市场版本')
  const ctx = await setup(t, { dialog: [{ fsPath: source }] })
  await fs.mkdir(path.join(ctx.workspace, '.agents'), { recursive: true })
  await fs.mkdir(path.join(ctx.skillsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(ctx.skillsRoot, 'demo/SKILL.md'), SKILL('demo', '市场版本'))
  const digest = await archive.digestDirectory(path.join(ctx.skillsRoot, 'demo'))
  const record = { skillId: 'ns/demo', source: 'market', name: '演示', version: '1.2.0', dir: '.agents/skills/demo', installedAt: 10, dirDigest: digest }
  await fs.writeFile(path.join(ctx.workspace, '.agents/skills.registry.json'), JSON.stringify({ version: 1, skills: [record] }))

  await fs.rm(path.join(ctx.skillsRoot, 'demo'), { recursive: true, force: true })
  await ctx.view.handle({ type: 'reimportSkill', dir: 'demo' })
  const after = (await registryOf(ctx.workspace))[0]
  assert.equal(after.skillId, 'ns/demo')
  assert.equal(after.source, 'market')
  assert.equal(after.version, '1.2.0')
  assert.equal(ctx.messages.at(-1).type, 'skillImported')

  // 目录内容被替换后再重新导入：拒绝，登记保持
  const tampered = await setup(t, { dialog: [{ fsPath: source }] })
  await fs.mkdir(path.join(tampered.workspace, '.agents'), { recursive: true })
  await fs.mkdir(path.join(tampered.skillsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(tampered.skillsRoot, 'demo/SKILL.md'), '被改过的内容')
  const digest2 = await archive.digestDirectory(path.join(tampered.skillsRoot, 'demo'))
  await fs.writeFile(path.join(tampered.workspace, '.agents/skills.registry.json'), JSON.stringify({ version: 1, skills: [{ ...record, dirDigest: `${digest2}tampered` }] }))
  await tampered.view.handle({ type: 'reimportSkill', dir: 'demo' })
  assert.equal(tampered.messages.at(-1).type, 'skillsError')
  assert.equal(tampered.messages.at(-1).code, 'SOURCE_VERIFY_FAILED')
  assert.equal((await registryOf(tampered.workspace)).length, 1)
})

test('移出登记只删登记，删除走回收站并拒绝 system 项', async t => {
  const ctx = await setup(t)
  await fs.mkdir(path.join(ctx.workspace, '.agents'), { recursive: true })
  await fs.mkdir(path.join(ctx.skillsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(ctx.skillsRoot, 'demo/SKILL.md'), SKILL('demo'))
  await fs.writeFile(path.join(ctx.workspace, '.agents/skills.registry.json'), JSON.stringify({ version: 1, skills: [{ skillId: 'local/demo', source: 'import', name: '演示', version: '0.0.0-local', dir: '.agents/skills/demo', installedAt: 1 }] }))

  await ctx.view.handle({ type: 'unregisterSkill', dir: 'demo' })
  assert.equal((await registryOf(ctx.workspace)).length, 0)
  assert.equal(await fs.stat(path.join(ctx.skillsRoot, 'demo/SKILL.md')).then(() => true, () => false), true)

  ctx.state.warningChoice = message => (String(message).includes('确认删除') ? '确认删除' : '删除')
  await ctx.view.handle({ type: 'deleteSkill', dir: 'demo' })
  assert.equal(ctx.state.deleted.length, 1)
  assert.deepEqual(ctx.state.deleted[0].opts, { recursive: true, useTrash: true })
  assert.equal(ctx.messages.at(-1).type, 'skillDeleted')

  // 手工放置项（索引 scope=system）不允许删除
  await ctx.view.handle({ type: 'installedSkills' })
  const payload = ctx.messages.at(-1)
  payload.skills[0].scope = 'system'
  ctx.view.installedSkillsPayload = async () => payload
  ctx.state.deleted = []
  await ctx.view.handle({ type: 'deleteSkill', dir: payload.skills[0].dir })
  assert.equal(ctx.state.deleted.length, 0)
  assert.match(ctx.messages.at(-1).message, /只读/)
})

test('启停失败回滚 pending 并给出原因；未登录也能列举技能', async t => {
  const ctx = await setup(t)
  await fs.mkdir(ctx.skillsRoot, { recursive: true })
  await fs.mkdir(path.join(ctx.skillsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(ctx.skillsRoot, 'demo/SKILL.md'), SKILL('demo'))

  // 未登录：accessToken 会抛错，但技能列表仍可用
  await ctx.view.handle({ type: 'listSkills' })
  assert.ok(ctx.messages.some(message => message.type === 'skills'), '未登录应返回技能列表')
  assert.equal(ctx.authCalls(), 0, 'listSkills 不应触发 accessToken')
  const installed = ctx.messages.filter(message => message.type === 'installedSkills').at(-1)
  assert.equal(installed.skills.length, 1)
  assert.equal(installed.skills[0].source, 'external')

  // 索引不可用：启停被拒绝并提示，不调用 config/write
  ctx.view.ensureSkillClient = async () => { throw new Error('codex 缺失') }
  ctx.requests.length = 0
  await ctx.view.handle({ type: 'installedSkills' })
  const offline = ctx.messages.at(-1)
  assert.equal(offline.indexAvailable, false)
  await ctx.view.handle({ type: 'setSkillEnabled', dir: 'demo', path: path.join(ctx.skillsRoot, 'demo/SKILL.md'), enabled: false })
  assert.equal(ctx.messages.at(-1).type, 'skillsError')
  assert.equal(ctx.messages.at(-1).enabled, true, '失败应把开关回滚成原值')
  assert.equal(ctx.requests.length, 0)

  // 索引可用：成功启停并回推列表
  ctx.view.ensureSkillClient = async () => ({ request: async (method, params) => {
    ctx.requests.push({ method, params })
    if (method === 'skills/config/write') return { data: {} }
    return { data: [{ skills: [{ name: 'demo', path: path.join(ctx.skillsRoot, 'demo/SKILL.md'), enabled: true, scope: 'repo' }], errors: [] }] }
  } })
  await ctx.view.handle({ type: 'installedSkills' })
  await ctx.view.handle({ type: 'setSkillEnabled', dir: 'demo', path: path.join(ctx.skillsRoot, 'demo/SKILL.md'), enabled: false })
  assert.ok(ctx.requests.some(item => item.method === 'skills/config/write' && item.params.enabled === false))
  assert.equal(ctx.messages.at(-1).type, 'installedSkills')
})
