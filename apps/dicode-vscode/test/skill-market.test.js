const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const market = require('../skillMarket')
const stub = require('../marketStub')
const { isRetryable } = require('../skillsModel')

const transport = body => async () => ({ status: 200, contentType: 'application/json', text: JSON.stringify(body) })
const raw = status => (contentType, text) => ({ status, contentType, text })

test('适配层：服务端字段映射为 UI 模型（5.1）', () => {
  const s = market.adaptSkill({ namespace: 'global', slug: 'pdf-tools', displayName: 'PDF 工具', createdByName: '张三', createdByDept: 'AI平台部', summary: 's', labels: ['文档处理'], needApiKey: true, icon: 'data:image/png;base64,x', updatedAt: '2026-03-01T10:00:00Z', downloadCount: 42, publishedVersion: { version: '1.2.0', status: 'PUBLISHED' } })
  assert.equal(s.id, 'global/pdf-tools')
  assert.equal(s.name, 'PDF 工具', 'name ← displayName')
  assert.equal(s.publisher, '张三', 'publisher ← createdByName')
  assert.equal(s.version, '1.2.0', 'version ← publishedVersion.version')
  assert.deepEqual(s.tags, ['文档处理'], 'tags ← labels')
  assert.equal(s.compat, 'compatible', '接口无字段默认 compatible')
  assert.equal(s.updatedAt, Date.parse('2026-03-01T10:00:00Z'))
  assert.equal(s.needApiKey, true)
})

test('适配层：列表无版本时空态、桩 compat 透传、非法 compat 落默认', () => {
  const bare = market.adaptSkill({ namespace: 'g', slug: 'x', displayName: 'x' })
  assert.equal(bare.version, '')
  assert.equal(bare.compat, 'compatible')
  assert.deepEqual(bare.tags, [])
  const restricted = market.adaptSkill({ namespace: 'g', slug: 'x', compat: 'restricted', compatReason: '该部门未授权', minClientVersion: '1.5.0' })
  assert.equal(restricted.compat, 'restricted')
  assert.equal(restricted.compatReason, '该部门未授权')
  assert.equal(market.adaptSkill({ namespace: 'g', slug: 'x', compat: 'weird' }).compat, 'compatible')
})

test('适配层：has_next 与 hasNext 双兼容', async () => {
  const snake = await market.searchSkills(transport({ success: true, items: [], total: 0, page: 0, size: 20, labelStats: [], has_next: true }), {})
  const camel = await market.searchSkills(transport({ success: true, items: [], total: 0, page: 0, size: 20, labelStats: [], hasNext: true }), {})
  assert.equal(snake.hasNext, true)
  assert.equal(camel.hasNext, true)
})

test('错误映射：HTTP 状态与 JSON 错误体 → 7.1 错误码', async () => {
  const cases = [
    [raw(401)('application/json', JSON.stringify({ success: false, code: 401, msg: 'token 失效' })), 'UNAUTHORIZED'],
    [raw(403)('application/json', JSON.stringify({ success: false, msg: '无权限' })), 'FORBIDDEN'],
    [raw(404)('application/json', JSON.stringify({ success: false, msg: '不存在' })), 'NOT_FOUND'],
    [raw(500)('application/json', JSON.stringify({ success: false, msg: 'boom' })), 'NETWORK'],
    [raw(200)('application/json', JSON.stringify({ success: false, msg: '业务失败' })), 'NETWORK'],
    [raw(200)('application/json', '{ broken'), 'NETWORK'],
    [raw(200)('application/json', JSON.stringify({ success: false, code: 403, msg: '网关包错误' })), 'FORBIDDEN'],
    [raw(200)('application/json', JSON.stringify({ success: false, code: 404, msg: '网关包错误' })), 'NOT_FOUND'],
  ]
  for (const [response, want] of cases) {
    await assert.rejects(() => market.unwrapJson(response, 'x'), error => error.code === want)
  }
  const e401 = await market.unwrapJson(cases[0][0], 'x').catch(error => error)
  assert.equal(e401.requiresLogin, true)
  assert.equal(e401.retryable, isRetryable('UNAUTHORIZED'))
  assert.equal((await market.unwrapJson(cases[1][0], 'x').catch(error => error)).retryable, false)
  assert.equal((await market.unwrapJson(cases[2][0], 'x').catch(error => error)).retryable, false)
  await assert.rejects(() => market.searchSkills(async () => { throw new Error('ECONNREFUSED') }), error => error.code === 'NETWORK')
})

test('splitSkillId：非法标识拒绝且映射 NOT_FOUND', () => {
  for (const invalid of ['', 'nsOnly', '/slug', 'ns/']) {
    assert.throws(() => market.splitSkillId(invalid), error => error.code === 'NOT_FOUND')
  }
})

test('桩响应形状与 docs/skillhub-api.md 一致', async () => {
  const t = stub.createTransport(stub.createStubState())
  const search = JSON.parse((await t({ path: '/search', query: { page: '0', size: '3' } })).text)
  assert.equal(search.success, true)
  assert.equal(typeof search.code, 'number')
  for (const key of ['items', 'total', 'page', 'size', 'labelStats', 'has_next']) assert.ok(key in search, `缺少 ${key}`)
  for (const key of ['slug', 'displayName', 'summary', 'icon', 'namespace', 'skillLabel', 'needApiKey', 'createdByName', 'createdByDept']) assert.ok(key in search.items[0], `items 缺少 ${key}`)
  assert.equal(search.has_next, true)
  const detail = JSON.parse((await t({ path: '/global/pdf-tools' })).text)
  for (const key of ['namespaces', 'labels', 'publishedVersion', 'headlineVersion', 'downloadCount', 'ratingAvg']) assert.ok(key in detail, `详情缺少 ${key}`)
  assert.equal(detail.publishedVersion.version, '1.2.0')
  const versions = JSON.parse((await t({ path: '/global/web-scraper/versions' })).text)
  assert.equal(versions.items[0].version, '1.3.0', '发布时间倒序')
  for (const key of ['changelog', 'totalSize', 'downloadReady', 'status']) assert.ok(key in versions.items[0], `版本缺少 ${key}`)
  const overview = await t({ path: '/global/pdf-tools/versions/1.2.0/file', query: { path: 'SKILL.md' } })
  assert.equal(overview.contentType, 'application/octet-stream')
  assert.ok(overview.text.includes('# PDF 工具'))
})

test('桩门禁与错误构造：DRAFT 概览 404、secret 403、目录失败 500', async () => {
  const state = stub.createStubState()
  const t = stub.createTransport(state)
  const draft = await t({ path: '/global/web-scraper/versions/1.3.0/file', query: { path: 'SKILL.md' } })
  assert.equal(JSON.parse(draft.text).success, false)
  const forbidden = await t({ path: '/global/secret-skill' })
  assert.equal(forbidden.status, 403)
  state.catalogFailure = true
  const failure = await t({ path: '/search' })
  assert.equal(failure.status, 500)
  state.unauthorized = true
  const unauthorized = await t({ path: '/search' })
  assert.equal(JSON.parse(unauthorized.text).code, 401)
})

test('缓存：分组按 q+label+sort、组内页码追加、互不覆盖', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-'))
  let clock = 1_000
  const cache = market.createCatalogCache({ cacheFile: path.join(dir, 'c.json'), now: () => clock })
  let calls = 0
  const fetcher = async params => { calls += 1; return { items: [{ id: 'g/x', page: params.page }], page: params.page, size: 20, total: 1, hasNext: false, labelStats: [] } }

  const first = await cache.search({ page: 0 }, fetcher)
  assert.equal(first.stale, false)
  assert.equal(first.query, '', '响应回带查询条件')
  await cache.search({ q: 'pdf', page: 0 }, fetcher)
  const again = await cache.search({ page: 0 }, fetcher)
  assert.equal(calls, 2, '命中缓存不再调 fetcher')
  assert.equal(again.items[0].page, 0, 'A 组未被 B 组覆盖')
  await cache.search({ page: 1 }, fetcher)
  const page1 = await cache.search({ page: 1 }, fetcher)
  assert.equal(page1.page, 1, '组内页码追加')
  await fs.rm(dir, { recursive: true, force: true })
})

test('缓存：TTL 过期标 stale、force 刷新后恢复新鲜', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-'))
  let clock = 1_000
  const cache = market.createCatalogCache({ cacheFile: path.join(dir, 'c.json'), now: () => clock })
  let calls = 0
  const fetcher = async () => { calls += 1; return { items: [], page: 0, size: 20, total: 0, hasNext: false, labelStats: [] } }
  await cache.search({ page: 0 }, fetcher)
  clock += market.DEFAULT_TTL_MS + 1
  const stale = await cache.search({ page: 0 }, fetcher)
  assert.equal(stale.stale, true, '过期先展示缓存')
  assert.equal(calls, 1)
  clock += 1
  const fresh = await cache.search({ page: 0 }, fetcher, { force: true })
  assert.equal(fresh.stale, false, 'force 绕过读缓存')
  assert.equal(calls, 2)
  assert.equal((await cache.search({ page: 0 }, fetcher)).stale, false)
  await fs.rm(dir, { recursive: true, force: true })
})

test('缓存：20 组上限 LRU 淘汰、被 touch 的组存活', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-'))
  let clock = 1_000
  const cache = market.createCatalogCache({ cacheFile: path.join(dir, 'c.json'), now: () => clock })
  const fetcher = async () => ({ items: [], page: 0, size: 20, total: 0, hasNext: false, labelStats: [] })
  for (let i = 0; i < 21; i++) { clock += 1; await cache.search({ q: 'k' + i, page: 0 }, fetcher) }
  let data = JSON.parse(await fs.readFile(path.join(dir, 'c.json'), 'utf8'))
  assert.equal(Object.keys(data.groups).length, 20)
  assert.ok(!data.groups[JSON.stringify(['', '', 'newest'])], '最旧组被淘汰')
  clock += 1
  await cache.search({ q: 'k1', page: 0 }, fetcher)
  for (let i = 100; i < 102; i++) { clock += 1; await cache.search({ q: 'k' + i, page: 0 }, fetcher) }
  data = JSON.parse(await fs.readFile(path.join(dir, 'c.json'), 'utf8'))
  assert.ok(data.groups[JSON.stringify(['k1', '', 'newest'])], 'LRU 而非 FIFO')
  assert.ok(!data.groups[JSON.stringify(['k2', '', 'newest'])])
  await fs.rm(dir, { recursive: true, force: true })
})

test('缓存：2MB 上限淘汰与损坏文件留 .bak', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-'))
  let clock = 1_000
  const big = market.createCatalogCache({ cacheFile: path.join(dir, 'big.json'), now: () => clock, maxGroups: 100, maxBytes: 200 * 1024 })
  const bigFetcher = async () => ({ items: Array.from({ length: 200 }, (_, i) => ({ id: 'i' + i, pad: 'x'.repeat(1024) })), page: 0, size: 20, total: 1, hasNext: false, labelStats: [] })
  for (let i = 0; i < 5; i++) { clock += 1; await big.search({ q: 'b' + i }, bigFetcher) }
  const data = JSON.parse(await fs.readFile(path.join(dir, 'big.json'), 'utf8'))
  assert.ok(JSON.stringify(data).length <= 200 * 1024, '字节上限生效')
  const brokenPath = path.join(dir, 'broken.json')
  await fs.writeFile(brokenPath, '{ corrupted')
  const broken = market.createCatalogCache({ cacheFile: brokenPath, now: () => clock })
  await broken.search({ page: 0 }, async () => ({ items: [], page: 0, size: 20, total: 0, hasNext: false, labelStats: [] }))
  assert.ok(await fs.stat(brokenPath + '.bak').then(() => true, () => false), '损坏留 .bak')
  const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))
  assert.equal(leftovers.length, 0, '原子写无 tmp 残留')
  await fs.rm(dir, { recursive: true, force: true })
})

/** 市场接线用 DicodeView 桩（配置可切换） */
async function makeView(t, { stubEnabled }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mkt-wire-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const workspace = path.join(temp, 'workspace')
  await fs.mkdir(workspace)
  const vscode = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      getConfiguration: () => ({ get: key => (key === 'skillMarketStub' ? stubEnabled : undefined) }),
      fs: { delete: async () => {} },
    },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    Uri: { file: value => ({ fsPath: value }) },
    commands: { executeCommand: async () => {} },
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain) }
  let DicodeView
  try {
    delete require.cache[require.resolve('../extension')]
    ;({ DicodeView } = require('../extension'))
  } finally { Module._load = originalLoad }
  const context = { extensionPath: path.join(__dirname, '..'), globalState: { get: (_, fallback) => fallback, update: async () => {} }, secrets: { get: async () => null }, globalStorageUri: { fsPath: path.join(temp, 'storage') } }
  const view = new DicodeView(context)
  const messages = []
  view.post = message => messages.push(message)
  return { view, messages, workspace }
}

test('extension 接线：桩模式目录/详情/登录/登出/安装出口', async t => {
  const { view, messages } = await makeView(t, { stubEnabled: true })
  const auth = await view.marketAuthPayload()
  assert.equal(auth.loggedIn, true, '桩初始登录态')
  assert.equal(auth.baseUrlConfigured, true)

  await view.handle({ type: 'marketList', page: 0 })
  const catalog = messages.find(message => message.type === 'marketCatalog')
  assert.equal(catalog.items.length, 11, '桩技能 12 条中 secret-skill 不可见')
  assert.equal(catalog.items[0].name, '超限用例', 'newest 排序适配后生效（最新发布时间）')
  assert.ok(Array.isArray(catalog.labelStats) && catalog.labelStats.length > 0)

  await view.handle({ type: 'marketList', page: 0 })
  const second = messages.filter(message => message.type === 'marketCatalog').at(-1)
  assert.equal(second.cachedAt, catalog.cachedAt, '第二次命中缓存')

  await view.handle({ type: 'marketList', query: 'PDF', page: 0 })
  const searched = messages.filter(message => message.type === 'marketCatalog').at(-1)
  assert.equal(searched.items.length, 1)
  assert.equal(searched.query, 'PDF')

  await view.handle({ type: 'marketDetail', skillId: 'global/pdf-tools' })
  const detail = messages.find(message => message.type === 'marketDetailResult')
  assert.equal(detail.skill.version, '1.2.0')
  assert.ok(detail.content.includes('# PDF 工具'))
  assert.equal(detail.versions.length, 2)

  await view.handle({ type: 'marketDetail', skillId: 'global/secret-skill' })
  const forbidden = messages.filter(message => message.type === 'marketError').at(-1)
  assert.equal(forbidden.scope, 'detail')
  assert.equal(forbidden.code, 'FORBIDDEN')

  await view.handle({ type: 'marketLogin', username: 'admin', password: 'wrong' })
  assert.equal(messages.filter(message => message.type === 'marketError').at(-1).scope, 'auth')
  await view.handle({ type: 'marketLogin', username: 'admin', password: 'admin123' })
  assert.equal(messages.at(-1).type, 'marketAuthState')
  assert.equal(messages.at(-1).loggedIn, true)
  await view.handle({ type: 'marketLogout' })
  assert.equal(messages.at(-1).loggedIn, false)

  await view.handle({ type: 'marketInstall', skillId: 'global/pdf-tools' })
  const installError = messages.at(-1)
  assert.equal(installError.type, 'marketError', '阶段 3 安装走真实门禁出口')
  assert.equal(installError.scope, 'install')
  assert.equal(installError.code, 'UNAUTHORIZED', '登出后安装被 401 拦截，错误出口与 requiresLogin 正确')
  assert.equal(installError.requiresLogin, true)
  assert.ok(installError.message.length > 0, '错误带可读原因')
  await view.dispose()
})

test('extension 接线：非桩与未配置基地址时远程禁用且给引导', async t => {
  delete process.env.SKILLHUB_BASE_URL
  const { view, messages } = await makeView(t, { stubEnabled: false })
  const auth = await view.marketAuthPayload()
  assert.equal(auth.baseUrlConfigured, false)
  assert.equal(auth.loggedIn, false, '真实模式未登录')
  await view.handle({ type: 'marketList', page: 0 })
  const error = messages.filter(message => message.type === 'marketError').at(-1)
  assert.equal(error.scope, 'catalog')
  assert.equal(error.code, 'NETWORK')
  assert.ok(error.message.includes('SKILLHUB_BASE_URL'), '明确告知配置要求')
  await view.handle({ type: 'marketDetail', skillId: 'global/pdf-tools' })
  assert.equal(messages.filter(message => message.type === 'marketError').at(-1).scope, 'detail')

  process.env.SKILLHUB_BASE_URL = 'http://hub.internal'
  const configured = await view.marketAuthPayload()
  assert.equal(configured.baseUrlConfigured, true, '基地址已配置时引导态正确')
  delete process.env.SKILLHUB_BASE_URL
  await view.dispose()
})
