const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const registry = require('../skillsRegistry')

/** 构造一条登记项 */
const record = (skillId, dir, source = 'market') => ({
  skillId,
  name: skillId.split('/').pop(),
  version: source === 'market' ? '1.0.0' : '0.0.0-local',
  digest: null,
  dirDigest: 'dir-digest',
  dir: `.agents/skills/${dir}`,
  source,
  origin: dir,
  installedAt: 1,
})

/** 每个用例一个独立工作区 */
async function makeWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-registry-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  return workspace
}

test('空工作区读出空登记，写入后可读回', async t => {
  const workspace = await makeWorkspace(t)
  const paths = registry.registryPaths(workspace)
  assert.equal(paths.file, path.join(workspace, '.agents', 'skills.registry.json'))
  assert.deepEqual(await registry.readRegistry(workspace), { skills: [], recovered: false })
  await registry.upsertRecord(workspace, record('ns/a', 'a'))
  const result = await registry.readRegistry(workspace)
  assert.equal(result.skills.length, 1)
  assert.equal(result.skills[0].skillId, 'ns/a')
  assert.equal(result.skills[0].dir, '.agents/skills/a')
  const raw = JSON.parse(await fs.readFile(paths.file, 'utf8'))
  assert.equal(raw.version, registry.REGISTRY_VERSION)
  assert.equal(raw.skills.length, 1)
  // 临时文件不残留
  assert.equal(await fs.stat(paths.tmp).then(() => true, () => false), false)
})

test('upsert 按 skillId 覆盖，同 dir 也覆盖，不产生重复记录', async t => {
  const workspace = await makeWorkspace(t)
  await registry.upsertRecord(workspace, record('ns/a', 'a'))
  await registry.upsertRecord(workspace, { ...record('ns/a', 'a'), version: '2.0.0' })
  let { skills } = await registry.readRegistry(workspace)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].version, '2.0.0')
  // 同目录换来源（重新导入）覆盖同一条
  await registry.upsertRecord(workspace, record('plain-name', 'a', 'import'))
  ;({ skills } = await registry.readRegistry(workspace))
  assert.equal(skills.length, 1)
  assert.equal(skills[0].source, 'import')
  assert.equal(skills[0].skillId, 'plain-name')
})

test('并发 upsert 全部落盘且不丢写', async t => {
  const workspace = await makeWorkspace(t)
  await Promise.all(Array.from({ length: 5 }, (_, index) => registry.upsertRecord(workspace, record(`ns/c${index}`, `c${index}`))))
  const { skills } = await registry.readRegistry(workspace)
  assert.equal(skills.length, 5)
})

test('原子写：并发写入期间任何一次读取都能解析出完整结构', async t => {
  const workspace = await makeWorkspace(t)
  const paths = registry.registryPaths(workspace)
  await registry.upsertRecord(workspace, record('ns/seed', 'seed'))
  const writer = Promise.all(Array.from({ length: 8 }, (_, index) => registry.upsertRecord(workspace, record(`ns/w${index}`, `w${index}`))))
  const reads = []
  for (let index = 0; index < 20; index++) {
    const raw = await fs.readFile(paths.file, 'utf8')
    reads.push(JSON.parse(raw).skills.length)
  }
  await writer
  for (const count of reads) assert.ok(count >= 1, '读到的条数应始终不少于种子记录')
})

test('损坏的登记文件留 .bak 并视为空登记', async t => {
  const workspace = await makeWorkspace(t)
  const paths = registry.registryPaths(workspace)
  await fs.mkdir(paths.dir, { recursive: true })
  await fs.writeFile(paths.file, '{ broken json')
  const result = await registry.readRegistry(workspace)
  assert.deepEqual(result, { skills: [], recovered: true })
  assert.equal(await fs.readFile(paths.backup, 'utf8'), '{ broken json')
  // 之后仍可正常写入
  await registry.upsertRecord(workspace, record('ns/a', 'a'))
  assert.equal((await registry.readRegistry(workspace)).skills.length, 1)
})

test('锁未失效时不抢占，等待超时报 LOCK_TIMEOUT', async t => {
  const workspace = await makeWorkspace(t)
  const paths = registry.registryPaths(workspace)
  await fs.mkdir(paths.dir, { recursive: true })
  await fs.writeFile(paths.lock, '{}')
  await assert.rejects(registry.upsertRecord(workspace, record('ns/a', 'a'), { timeoutMs: 150 }), error => error.code === 'LOCK_TIMEOUT')
  // 锁仍在，持有者可以继续持有
  assert.equal(await fs.stat(paths.lock).then(() => true, () => false), true)
})

test('过期锁可被接管，正常调用后锁被释放', async t => {
  const workspace = await makeWorkspace(t)
  const paths = registry.registryPaths(workspace)
  await fs.mkdir(paths.dir, { recursive: true })
  await fs.writeFile(paths.lock, '{}')
  const old = new Date(Date.now() - registry.LOCK_STALE_MS * 2)
  await fs.utimes(paths.lock, old, old)
  await registry.upsertRecord(workspace, record('ns/a', 'a'), { timeoutMs: 500 })
  assert.equal((await registry.readRegistry(workspace)).skills.length, 1)
  assert.equal(await fs.stat(paths.lock).then(() => true, () => false), false)
})

test('removeRecord 只动登记返回是否命中', async t => {
  const workspace = await makeWorkspace(t)
  await registry.upsertRecord(workspace, record('ns/a', 'a'))
  await registry.upsertRecord(workspace, record('ns/b', 'b', 'import'))
  assert.equal(await registry.removeRecord(workspace, { skillId: 'ns/b' }), true)
  assert.equal((await registry.readRegistry(workspace)).skills.length, 1)
  assert.equal(await registry.removeRecord(workspace, { skillId: 'ns/a', source: 'import' }), false)
  assert.equal(await registry.removeRecord(workspace, { skillId: 'ns/a', source: 'market' }), true)
  assert.equal(await registry.removeRecord(workspace, { skillId: 'ns/none' }), false)
  assert.deepEqual((await registry.readRegistry(workspace)).skills, [])
})

test('mutate 返回 undefined 时不写盘', async t => {
  const workspace = await makeWorkspace(t)
  await registry.upsertRecord(workspace, record('ns/a', 'a'))
  const paths = registry.registryPaths(workspace)
  const before = await fs.readFile(paths.file, 'utf8')
  const list = await registry.updateRegistry(workspace, () => undefined)
  assert.equal(list.length, 1)
  assert.equal(await fs.readFile(paths.file, 'utf8'), before)
})

test('gitignore 检测识别常见写法，追加时不重复', async t => {
  const workspace = await makeWorkspace(t)
  const gitignore = path.join(workspace, '.gitignore')
  assert.equal(await registry.isRegistryIgnored(workspace), false)
  for (const pattern of ['.agents', '.agents/', '/.agents/', '.agents/**', '.agents/skills.registry.json', '*']) {
    await fs.writeFile(gitignore, `node_modules\n${pattern}\n`)
    assert.equal(await registry.isRegistryIgnored(workspace), true, `${pattern} 应被识别为已忽略`)
  }
  await fs.writeFile(gitignore, '# .agents\n!/.agents/\nnode_modules\n')
  assert.equal(await registry.isRegistryIgnored(workspace), false, '注释与反选不算已忽略')
  await fs.writeFile(gitignore, 'node_modules')
  assert.equal(await registry.appendRegistryIgnore(workspace), true)
  const content = await fs.readFile(gitignore, 'utf8')
  assert.match(content, /\.agents\/skills\.registry\.json/)
  assert.match(content, /node_modules\n/, '追加时不能破坏原有内容')
  assert.equal(await registry.appendRegistryIgnore(workspace), false, '已忽略时不重复追加')
})

test('normalizeRecord 拒绝不合法来源与越权目录', () => {
  assert.throws(() => registry.normalizeRecord({ ...record('ns/a', 'a'), source: 'external' }), /来源不合法/)
  assert.throws(() => registry.normalizeRecord({ ...record('ns/a', 'a'), dir: '.agents/skills/../evil' }), /目录名/)
  assert.throws(() => registry.normalizeRecord({ ...record('ns/a', 'a'), dir: 'other/a' }), /必须是/)
  assert.throws(() => registry.normalizeRecord({ skillId: 'ns/a', dir: '.agents/skills/a' }), /来源不合法/)
  assert.equal(registry.normalizeRecord(record('ns/a', 'a')).dir, '.agents/skills/a')
})
