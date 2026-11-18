const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const view = require('../installedView')

/** 每个用例一个独立工作区 */
async function makeWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-installed-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  return workspace
}

const skillsRootOf = workspace => path.join(workspace, '.agents', 'skills')

/** 在技能目录下写一个 SKILL.md */
async function writeSkill(workspace, dir, name, description = '') {
  const dirPath = path.join(skillsRootOf(workspace), dir)
  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(path.join(dirPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文`)
  return dirPath
}

/** 构造登记项 */
const record = (skillId, dir, source = 'market', extra = {}) => ({
  skillId,
  name: skillId.split('/').pop(),
  version: source === 'market' ? '1.0.0' : '0.0.0-local',
  digest: null,
  dirDigest: 'dir-digest',
  dir: `.agents/skills/${dir}`,
  source,
  origin: dir,
  installedAt: 1,
  ...extra,
})

/** 构造索引项 */
const indexItem = (workspace, dir, extra = {}) => ({
  name: dir,
  description: `${dir} 的描述`,
  path: path.join(skillsRootOf(workspace), dir, 'SKILL.md'),
  enabled: true,
  scope: 'repo',
  ...extra,
})

test('三类来源各一条：market、import、external', async t => {
  const workspace = await makeWorkspace(t)
  await writeSkill(workspace, 'alpha', 'Alpha', '市场技能')
  await writeSkill(workspace, 'beta', 'Beta', '导入技能')
  await writeSkill(workspace, 'gamma', 'Gamma', '手工技能')
  const scanned = await view.scanSkillDirs(skillsRootOf(workspace))
  const items = view.buildInstalledView({
    workspace,
    records: [record('ns/alpha', 'alpha'), record('beta', 'beta', 'import')],
    index: [indexItem(workspace, 'alpha'), indexItem(workspace, 'beta'), indexItem(workspace, 'gamma')],
    scanned,
  })
  assert.equal(items.length, 3)
  const byDir = Object.fromEntries(items.map(item => [item.dir, item]))
  assert.equal(byDir.alpha.source, 'market')
  assert.equal(byDir.alpha.external, false)
  assert.equal(byDir.beta.source, 'import')
  assert.equal(byDir.gamma.source, 'external')
  assert.equal(byDir.gamma.external, true)
  assert.equal(byDir.gamma.name, 'Gamma', '手工放置项名称取 SKILL.md')
  assert.equal(byDir.gamma.summary, '手工技能')
  assert.equal(byDir.alpha.enabled, true)
  for (const item of items) {
    assert.equal(item.missing, false)
    assert.equal(item.indexStale, false)
  }
})

test('登记有而目录不存在标 missing，且不被隐藏', async t => {
  const workspace = await makeWorkspace(t)
  const items = view.buildInstalledView({
    workspace,
    records: [record('ns/gone', 'gone')],
    index: [],
    scanned: [],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].missing, true)
  assert.equal(items[0].external, false)
  assert.equal(items[0].source, 'market')
  assert.equal(items[0].name, 'gone')
})

test('登记有、目录在、索引缺该项时标 indexStale', async t => {
  const workspace = await makeWorkspace(t)
  await writeSkill(workspace, 'alpha', 'Alpha')
  const scanned = await view.scanSkillDirs(skillsRootOf(workspace))
  const stale = view.buildInstalledView({ workspace, records: [record('ns/alpha', 'alpha')], index: [], scanned })
  assert.equal(stale[0].indexStale, true)
  const fresh = view.buildInstalledView({ workspace, records: [record('ns/alpha', 'alpha')], index: [indexItem(workspace, 'alpha')], scanned })
  assert.equal(fresh[0].indexStale, false)
})

test('CLI 不可用时不误标 indexStale，enabled 显示未知', async t => {
  const workspace = await makeWorkspace(t)
  await writeSkill(workspace, 'alpha', 'Alpha')
  const scanned = await view.scanSkillDirs(skillsRootOf(workspace))
  const items = view.buildInstalledView({ workspace, records: [record('ns/alpha', 'alpha')], index: [], scanned, indexAvailable: false })
  assert.equal(items[0].indexStale, false)
  assert.equal(items[0].enabled, null)
})

test('残留目录与隐藏目录不被当成技能项', async t => {
  const workspace = await makeWorkspace(t)
  await writeSkill(workspace, 'real', 'Real')
  await writeSkill(workspace, '.tmp-1234', 'Temp')
  await writeSkill(workspace, 'real.new', 'New')
  await writeSkill(workspace, 'real.bak', 'Bak')
  await writeSkill(workspace, '.hidden', 'Hidden')
  await fs.mkdir(path.join(skillsRootOf(workspace), 'not-a-skill'), { recursive: true })
  const scanned = await view.scanSkillDirs(skillsRootOf(workspace))
  assert.deepEqual(scanned.map(item => item.dir).sort(), ['not-a-skill', 'real'], '残留目录在扫描阶段就被排除')
  const items = view.buildInstalledView({ workspace, records: [], index: [], scanned })
  assert.deepEqual(items.map(item => item.dir), ['real'], '没有 SKILL.md 的目录不算技能项')
  assert.equal(view.isResidualName('x.tmp-1'), false, '只有点开头的 tmp 才算残留')
  assert.equal(view.isResidualName('.tmp-1'), true)
  assert.equal(view.isResidualName('x.NEW'), true)
  assert.equal(view.isResidualName('x.bak'), true)
})

test('按名称稳定排序', async t => {
  const workspace = await makeWorkspace(t)
  for (const dir of ['zeta', 'alpha', 'beta']) await writeSkill(workspace, dir, dir)
  const scanned = await view.scanSkillDirs(skillsRootOf(workspace))
  const items = view.buildInstalledView({ workspace, records: [], index: [], scanned })
  assert.deepEqual(items.map(item => item.dir), ['alpha', 'beta', 'zeta'])
})

test('index 路径解析拒绝越界与根部文件', () => {
  const workspace = 'C:\\ws'
  const root = view.dirFromIndexPath
  assert.equal(root(path.join('C:\\ws', '.agents', 'skills'), path.join('C:\\ws', '.agents', 'skills', 'alpha', 'SKILL.md')), 'alpha')
  assert.equal(root(path.join('C:\\ws', '.agents', 'skills'), path.join('C:\\ws', '.agents', 'skills', 'SKILL.md')), '')
  assert.equal(root(path.join('C:\\ws', '.agents', 'skills'), 'C:\\other\\skill\\SKILL.md'), '')
  assert.equal(root(path.join('C:\\ws', '.agents', 'skills'), ''), '')
  assert.equal(root(path.join('C:\\ws', '.agents', 'skills'), path.join('C:\\ws', '.agents', 'skills', 'a', 'b', 'SKILL.md')), 'a')
})

test('没有 .agents/skills 时扫描返回空数组', async t => {
  const workspace = await makeWorkspace(t)
  assert.deepEqual(await view.scanSkillDirs(skillsRootOf(workspace)), [])
  assert.deepEqual(view.buildInstalledView({ workspace, records: [], index: [], scanned: [] }), [])
})

test('frontmatter 缺字段或文件缺失时用目录名兜底', async t => {
  const workspace = await makeWorkspace(t)
  const bare = path.join(skillsRootOf(workspace), 'bare')
  await fs.mkdir(bare, { recursive: true })
  await fs.writeFile(path.join(bare, 'SKILL.md'), '# 没有 frontmatter')
  const empty = path.join(skillsRootOf(workspace), 'empty')
  await fs.mkdir(empty, { recursive: true })
  const scanned = await view.scanSkillDirs(skillsRootOf(workspace))
  const byDir = Object.fromEntries(scanned.map(item => [item.dir, item]))
  assert.equal(byDir.bare.name, '')
  assert.equal(byDir.bare.hasSkillMd, true)
  assert.equal(byDir.empty.hasSkillMd, false)
  const items = view.buildInstalledView({ workspace, records: [], index: [], scanned })
  assert.equal(items.find(item => item.dir === 'bare').name, 'bare')
  assert.equal(items.some(item => item.dir === 'empty'), false, '没有 SKILL.md 的目录不进列表')
})
