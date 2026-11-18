const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const archive = require('../skillArchive')

/** 最小 ZIP 写入器：只为测试造包，不追求格式覆盖面 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const spec of entries) {
    const raw = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data || '')
    const method = spec.method ?? 8
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw
    const name = Buffer.from(spec.name, 'utf8')
    const isDirectory = spec.name.endsWith('/')
    const uncompressed = spec.uncompressedSize ?? raw.length
    const crc = spec.crc ?? archive.crc32(raw)
    const flags = spec.encrypted ? 1 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(uncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // unix host，才能用外部属性表达符号链接
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(uncompressed, 24)
    central.writeUInt16LE(name.length, 28)
    const mode = spec.symlink ? 0o120777 : isDirectory ? 0o40755 : 0o100644
    central.writeUInt32LE(((mode << 16) | (isDirectory ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + payload.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

const SKILL = name => `---\nname: ${name}\ndescription: 测试技能\n---\n\n# 用法\n`
const skillEntry = (name, dir = 'demo', extra = {}) => ({
  name: `${dir}/SKILL.md`,
  data: SKILL(name),
  ...extra,
})

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-archive-'))
  const skillsRoot = path.join(workspace, '.agents', 'skills')
  await fs.mkdir(skillsRoot, { recursive: true })
  try {
    return await run({ workspace, skillsRoot })
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

async function expectCode(promise, code, kind) {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实得 ${error.code}：${error.message}`)
    if (kind) assert.equal(error.kind, kind)
    return error
  }
  assert.fail(`期望抛出 ${code}，实际成功`)
}

test('store 与 deflate 都能解出，单层根目录被剥离', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    const buffer = makeZip([
      { name: 'demo/', data: '', method: 0 },
      skillEntry('演示技能', 'demo', { method: 0 }),
      { name: 'demo/README.md', data: '说明', method: 8 },
    ])
    const result = await archive.extractArchive({ buffer, skillsRoot })
    assert.equal(result.dirName, 'demo')
    assert.equal(result.skillRoot, 'demo')
    assert.equal(result.files, 2)
    assert.match(result.digest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(await fs.readFile(path.join(result.stagingSkillPath, 'README.md'), 'utf8'), '说明')
    await archive.discardStaged(result.stagingRoot)
    assert.deepEqual(await fs.readdir(skillsRoot), [])
  })
})

test('多层结构以 SKILL.md 所在目录为技能根，目录名取该层目录名', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    const buffer = makeZip([
      { name: 'pkg/docs/note.md', data: '文档' },
      { name: 'pkg/skill/SKILL.md', data: SKILL('深层技能') },
      { name: 'pkg/skill/run.md', data: '步骤' },
    ])
    const result = await archive.extractArchive({ buffer, skillsRoot })
    assert.equal(result.dirName, 'skill')
    assert.equal(result.skillRoot, 'pkg/skill')
    assert.equal(await fs.readFile(path.join(result.stagingSkillPath, 'run.md'), 'utf8'), '步骤')
    await archive.discardStaged(result.stagingRoot)
  })
})

test('根部直放时退回 frontmatter name 作为目录名', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    const buffer = makeZip([{ name: 'SKILL.md', data: SKILL('direct-skill') }])
    const result = await archive.extractArchive({ buffer, skillsRoot })
    assert.equal(result.dirName, 'direct-skill')
    await archive.discardStaged(result.stagingRoot)
  })
})

test('多个技能目录、路径穿越、绝对路径、反斜杠、符号链接、加密、未知方法都被拒绝', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    const cases = [
      { label: '多技能目录', entries: [skillEntry('a', 'a'), skillEntry('b', 'b')], code: 'ARCHIVE_INVALID' },
      { label: '向上穿越', entries: [{ name: '../evil.txt', data: 'x' }, skillEntry('a')], code: 'ARCHIVE_INVALID' },
      { label: '绝对路径', entries: [{ name: '/etc/passwd', data: 'x' }, skillEntry('a')], code: 'ARCHIVE_INVALID' },
      { label: '盘符路径', entries: [{ name: 'C:/Windows/x', data: 'x' }, skillEntry('a')], code: 'ARCHIVE_INVALID' },
      { label: '反斜杠', entries: [{ name: 'demo\\x.txt', data: 'x' }, skillEntry('a')], code: 'ARCHIVE_INVALID' },
      { label: '符号链接', entries: [{ name: 'demo/link', data: 'demo/SKILL.md', symlink: true }, skillEntry('a')], code: 'ARCHIVE_INVALID' },
      { label: '加密条目', entries: [skillEntry('a', 'demo', { encrypted: true })], code: 'ARCHIVE_INVALID' },
      { label: '未知压缩方式', entries: [{ name: 'demo/SKILL.md', data: SKILL('a'), method: 9 }], code: 'ARCHIVE_INVALID' },
    ]
    for (const item of cases) {
      await expectCode(archive.extractArchive({ buffer: makeZip(item.entries), skillsRoot }), item.code).catch(error => {
        throw new Error(`${item.label}: ${error.message}`)
      })
    }
    // 每种失败都不留暂存目录
    assert.deepEqual(await fs.readdir(skillsRoot), [])
  })
})

test('CRC 不符报 ARCHIVE_CORRUPT 并清理暂存', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    const buffer = makeZip([{ name: 'demo/SKILL.md', data: SKILL('a'), crc: 1 }])
    await expectCode(archive.extractArchive({ buffer, skillsRoot }), 'ARCHIVE_CORRUPT')
    assert.deepEqual(await fs.readdir(skillsRoot), [])
  })
})

test('超限包、超单文件、超文件数都报 ARCHIVE_TOO_LARGE', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    await expectCode(
      archive.extractArchive({ buffer: Buffer.alloc(archive.ARCHIVE_LIMITS.maxArchiveBytes + 1), skillsRoot }),
      'ARCHIVE_TOO_LARGE',
    )
    await expectCode(
      archive.extractArchive({ buffer: makeZip([{ name: 'demo/SKILL.md', data: SKILL('a'), uncompressedSize: archive.ARCHIVE_LIMITS.maxEntryBytes + 1 }]), skillsRoot }),
      'ARCHIVE_TOO_LARGE',
    )
    const many = Array.from({ length: archive.ARCHIVE_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `demo/f${index}.txt`, data: 'x' }))
    await expectCode(archive.extractArchive({ buffer: makeZip(many), skillsRoot }), 'ARCHIVE_TOO_LARGE')
    assert.deepEqual(await fs.readdir(skillsRoot), [])
  })
})

test('缺少 SKILL.md、frontmatter 不全、目录名不合法都被拒绝', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    await expectCode(archive.extractArchive({ buffer: makeZip([{ name: 'demo/README.md', data: 'x' }]), skillsRoot }), 'ARCHIVE_INVALID')
    await expectCode(archive.extractArchive({ buffer: makeZip([{ name: 'demo/SKILL.md', data: '---\nname: a\n---\n' }]), skillsRoot }), 'ARCHIVE_INVALID')
    await expectCode(archive.extractArchive({ buffer: makeZip([skillEntry('a', 'CON')]), skillsRoot }), 'ARCHIVE_INVALID', 'RESERVED')
    await expectCode(archive.extractArchive({ buffer: makeZip([skillEntry('a', 'trail.')]), skillsRoot }), 'ARCHIVE_INVALID', 'TRAILING')
    assert.deepEqual(await fs.readdir(skillsRoot), [])
  })
})

test('commitStaged 覆盖时先备份再切换，旧内容不残留', async () => {
  await withWorkspace(async ({ skillsRoot }) => {
    const target = path.join(skillsRoot, 'demo')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'OLD.md'), 'old')
    const buffer = makeZip([skillEntry('新版本', 'demo')])
    const staged = await archive.extractArchive({ buffer, skillsRoot })

    await expectCode(archive.commitStaged({ ...staged, skillsRoot, dirName: 'demo' }), 'DIR_CONFLICT')
    assert.ok((await fs.readdir(skillsRoot)).some(name => name.startsWith('.tmp-')))

    await archive.commitStaged({ ...staged, skillsRoot, dirName: 'demo', replace: true })
    const names = (await fs.readdir(target)).sort()
    assert.deepEqual(names, ['SKILL.md'])
    assert.deepEqual((await fs.readdir(skillsRoot)).filter(name => name.startsWith('.tmp-')), [])
  })
})

test('stageFolder 复制文件夹、拒绝符号链接与非法目录名', async () => {
  await withWorkspace(async ({ skillsRoot, workspace }) => {
    const source = path.join(workspace, 'my-skill')
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(path.join(source, 'SKILL.md'), SKILL('我的技能'))
    await fs.writeFile(path.join(source, 'run.md'), '步骤')
    const staged = await archive.stageFolder({ sourcePath: source, skillsRoot })
    assert.equal(staged.dirName, 'my-skill')
    assert.equal(staged.files, 2)
    await fs.writeFile(path.join(staged.stagingSkillPath, 'x.md'), 'x')
    await archive.discardStaged(staged.stagingRoot)

    const withLink = path.join(workspace, 'link-skill')
    await fs.mkdir(withLink, { recursive: true })
    await fs.writeFile(path.join(withLink, 'SKILL.md'), SKILL('链接'))
    try {
      await fs.symlink(path.join(source, 'run.md'), path.join(withLink, 'run.md'))
    } catch {
      return // 无权限创建符号链接的环境跳过这一条
    }
    await expectCode(archive.stageFolder({ sourcePath: withLink, skillsRoot }), 'ARCHIVE_INVALID')

    const badName = path.join(workspace, 'CON')
    await fs.mkdir(badName, { recursive: true })
    await fs.writeFile(path.join(badName, 'SKILL.md'), SKILL('保留名'))
    await expectCode(archive.stageFolder({ sourcePath: badName, skillsRoot }), 'ARCHIVE_INVALID', 'RESERVED')

    const noSkill = path.join(workspace, 'empty-skill')
    await fs.mkdir(noSkill, { recursive: true })
    await expectCode(archive.stageFolder({ sourcePath: noSkill, skillsRoot }), 'ARCHIVE_INVALID')
    assert.deepEqual((await fs.readdir(skillsRoot)).filter(name => name.startsWith('.tmp-')), [])
  })
})

test('digestDirectory 与文件顺序、绝对路径无关', async () => {
  await withWorkspace(async ({ workspace }) => {
    const a = path.join(workspace, 'a')
    const b = path.join(workspace, 'other-location', 'a')
    for (const dir of [a, b]) {
      await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
      await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL('x'))
      await fs.writeFile(path.join(dir, 'sub', 'file.md'), '内容')
    }
    assert.equal(await archive.digestDirectory(a), await archive.digestDirectory(b))
    await fs.writeFile(path.join(b, 'sub', 'file.md'), '改过的内容')
    assert.notEqual(await archive.digestDirectory(a), await archive.digestDirectory(b))
  })
})
