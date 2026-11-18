const { test } = require('node:test')
const assert = require('node:assert/strict')
const model = require('../skillsModel')

const MARKET_CATALOG = { id: 'ns/demo', compat: 'compatible', version: '1.0.0' }
const MARKET_RECORD = { skillId: 'ns/demo', source: 'market', version: '1.0.0', dir: '.agents/skills/demo' }

/** 构造安装任务 */
const job = (state, extra = {}) => ({ jobId: 'j1', state, retryable: true, ...extra })

test('错误码表与 7.1 完全对齐', () => {
  assert.equal(model.ERROR_CODE_NAMES.length, 15)
  const retryable = ['NETWORK', 'UNAUTHORIZED', 'ARCHIVE_CORRUPT', 'DISK_FULL', 'VERSION_CONFLICT', 'LOCK_TIMEOUT', 'INTERRUPTED']
  const blocked = ['FORBIDDEN', 'NOT_FOUND', 'INCOMPATIBLE_CLIENT', 'ORG_RESTRICTED', 'SOURCE_VERIFY_FAILED', 'ARCHIVE_INVALID', 'ARCHIVE_TOO_LARGE', 'DIR_CONFLICT']
  for (const code of retryable) assert.equal(model.isRetryable(code), true, `${code} 应可重试`)
  for (const code of blocked) assert.equal(model.isRetryable(code), false, `${code} 不应可重试`)
  assert.equal(model.ERROR_CODES.UNAUTHORIZED.requiresLogin, true)
})

test('未知错误码按不可重试处理', () => {
  assert.equal(model.isRetryable('SOMETHING_NEW'), false)
  assert.equal(model.errorInfo(undefined).retryable, false)
  assert.match(model.errorInfo('SOMETHING_NEW').message, /未知错误/)
})

test('目录名校验按 5.5 拒绝不合规名称', async t => {
  const backslash = String.fromCharCode(92)
  const cases = [
    ['', 'EMPTY'],
    ['.', 'DOT'],
    ['..', 'DOT'],
    ['a/b', 'SEPARATOR'],
    [`a${backslash}b`, 'SEPARATOR'],
    ['a\u0000b', 'CONTROL'],
    ['a\u007fb', 'CONTROL'],
    ['.hidden', 'HIDDEN'],
    ['CON', 'RESERVED'],
    ['con', 'RESERVED'],
    ['Aux.txt', 'RESERVED'],
    ['COM1', 'RESERVED'],
    ['lpt9', 'RESERVED'],
    ['NUL', 'RESERVED'],
    ['trail.', 'TRAILING'],
    ['trail ', 'TRAILING'],
    ['   ', 'TRAILING'],
    ['a'.repeat(65), 'TOO_LONG'],
  ]
  for (const [name, kind] of cases) {
    await t.test(`${JSON.stringify(name)} → ${kind}`, () => {
      const result = model.validateDirName(name)
      assert.equal(result.ok, false)
      assert.equal(result.kind, kind)
      assert.ok(result.message)
    })
  }
})

test('目录名校验保留合法原名，不做折叠与替换', () => {
  for (const name of ['my-skill', 'My Skill', '技能一', 'CONSOLE', 'COM10', 'v1.2.3', 'a'.repeat(64)]) {
    const result = model.validateDirName(name)
    assert.deepEqual(result, { ok: true, dir: name })
  }
  assert.equal(model.validateDirName(123).ok, false)
})

test('normalizeDirName 不合规时抛 ARCHIVE_INVALID', () => {
  assert.equal(model.normalizeDirName('demo'), 'demo')
  assert.throws(() => model.normalizeDirName('CON'), error => {
    assert.equal(error.code, 'ARCHIVE_INVALID')
    assert.equal(error.kind, 'RESERVED')
    assert.match(error.message, /Windows 保留名/)
    return true
  })
})

test('compareVersion 按语义版本比较', async t => {
  const cases = [
    ['1.0.0', '1.0.0', 0],
    ['1.10.0', '1.9.0', 1],
    ['1.0', '1.0.0', 0],
    ['1.0.0-beta.2', '1.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['2.0.0', '10.0.0', -1],
    ['v1.2.3', '1.2.3', 0],
    ['1.0.0+build.5', '1.0.0', 0],
    ['0.0.0-local', '0.0.0', -1],
    ['1.0.0-beta', '1.0.0-alpha', 1],
    ['1.2.3', '1.2.3.4', -1],
  ]
  for (const [a, b, want] of cases) {
    await t.test(`${a} vs ${b}`, () => {
      assert.equal(model.compareVersion(a, b), want)
      assert.equal(model.compareVersion(b, a), want === 0 ? 0 : -want)
    })
  }
})

test('dedupeKey 三段拼接不碰撞且稳定', () => {
  assert.equal(model.dedupeKey('w', 'ns/demo', '1.0.0'), model.dedupeKey('w', 'ns/demo', '1.0.0'))
  assert.notEqual(model.dedupeKey('a', 'b/c', '1'), model.dedupeKey('a', 'b', 'c/1'))
  assert.notEqual(model.dedupeKey('w', 'ns/demo', '1.0.0'), model.dedupeKey('w', 'ns/demo', '1.0.1'))
})

test('workspaceIdFor 归一化路径并稳定散列', () => {
  const backslash = String.fromCharCode(92)
  const windows = `D:${backslash}ssd-projects${backslash}costrict`
  const id = model.workspaceIdFor(windows)
  assert.match(id, /^[0-9a-f]{12}$/)
  assert.equal(id, model.workspaceIdFor('d:/ssd-projects/costrict'))
  assert.equal(id, model.workspaceIdFor('D:/ssd-projects/costrict/'))
  assert.notEqual(model.workspaceIdFor('/home/A'), model.workspaceIdFor('/home/a'))
  assert.notEqual(model.workspaceIdFor('/x'), model.workspaceIdFor('/y'))
})

test('deriveState 覆盖五态与 5.4 按钮映射', async t => {
  const cases = [
    ['无登记、兼容 → 安装', {}, { state: 'ready', button: '安装', enabled: true, note: '' }],
    ['目标目录被占用 → 附注', { dirTaken: true }, { state: 'ready', button: '安装', enabled: true, note: '本地已有同名技能' }],
    ['排队中', { job: job('queued') }, { state: 'installing', button: '安装中…', enabled: false, note: '排队中', jobId: 'j1' }],
    ['下载进度', { job: job('downloading', { progress: 35.4 }) }, { state: 'installing', button: '安装中…', enabled: false, note: '下载中 35%' }],
    ['已安装', { record: MARKET_RECORD, skillMdExists: true }, { state: 'installed', button: '已安装', enabled: false, note: '', version: '1.0.0' }],
    ['已安装且有新版', { catalog: { ...MARKET_CATALOG, version: '1.1.0' }, record: MARKET_RECORD, skillMdExists: true }, { state: 'installed', button: '已安装', enabled: false, note: '有 v1.1.0 可用' }],
    ['已安装但内容被改', { record: { ...MARKET_RECORD, altered: true }, skillMdExists: true }, { state: 'installed', button: '已安装', enabled: false, note: '目录内容已变化' }],
    ['可重试失败 → 重试', { job: job('failed', { errorCode: 'ARCHIVE_CORRUPT', errorMessage: '包损坏' }) }, { state: 'failed', button: '重试', enabled: true, note: '包损坏', errorCode: 'ARCHIVE_CORRUPT' }],
    ['不可重试失败 → 无法安装', { job: job('failed', { retryable: false, errorCode: 'DIR_CONFLICT' }) }, { state: 'blocked', button: '无法安装', enabled: false, note: '目标目录已被其他技能占用', errorCode: 'DIR_CONFLICT' }],
    ['目录级不兼容', { catalog: { ...MARKET_CATALOG, compat: 'incompatible', minClientVersion: '1.5.0' } }, { state: 'blocked', button: '不兼容', enabled: false, note: '需要插件 v1.5.0 及以上' }],
    ['目录级已限制', { catalog: { ...MARKET_CATALOG, compat: 'restricted', compatReason: '该部门未授权' } }, { state: 'blocked', button: '已限制', enabled: false, note: '该部门未授权' }],
    ['import 来源不算已安装', { record: { ...MARKET_RECORD, source: 'import' }, skillMdExists: true }, { state: 'ready', button: '安装', enabled: true, note: '' }],
    ['登记在但目录缺失', { record: MARKET_RECORD, skillMdExists: false }, { state: 'ready', button: '安装', enabled: true, note: '登记存在但目录缺失，可重新安装' }],
    ['done 任务不阻塞', { record: MARKET_RECORD, job: job('done'), skillMdExists: true }, { state: 'installed', button: '已安装', enabled: false }],
  ]
  for (const [label, options, want] of cases) {
    await t.test(label, () => {
      const got = model.deriveState({ catalog: MARKET_CATALOG, ...options })
      for (const key of Object.keys(want)) assert.deepEqual(got[key], want[key], `.${key}`)
    })
  }
})

test('已安装判定不比对 digest，digest 不一致只作附注', () => {
  const changed = { ...MARKET_RECORD, digest: 'sha256:other' }
  assert.equal(model.isInstalled(changed, true), true)
  assert.equal(model.deriveState({ catalog: MARKET_CATALOG, record: changed, skillMdExists: true }).note, '')
})

test('isInstalled 只认 market 来源与存在的 SKILL.md', () => {
  assert.equal(model.isInstalled(MARKET_RECORD, true), true)
  assert.equal(model.isInstalled({ ...MARKET_RECORD, source: 'import' }, true), false)
  assert.equal(model.isInstalled(MARKET_RECORD, false), false)
  assert.equal(model.isInstalled(null, true), false)
})
