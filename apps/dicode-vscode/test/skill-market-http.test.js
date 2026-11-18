'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createSkillHubAuth } = require('../skillHubAuth')
const { createHttpTransport, searchSkills, fetchSkillDetail, fetchDownload, unwrapJson, MarketError } = require('../skillMarket')

/**
 * 按docs/skillhub-api.md 契约形状起本地 mock 服务器，真实 HTTP 传输对它做端到端验证。
 * 每条请求记录到 serverState.calls 供断言（鉴权头/URL/UA 无关项）。
 */
function startHubServer(handlers = {}) {
  const state = { calls: [], tokenSeen: [] }
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://localhost')
      const record = { method: request.method, pathname: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization || '', body: Buffer.concat(chunks).toString('utf8') }
      state.calls.push(record)
      if (url.pathname === '/login') {
        const form = new URLSearchParams(record.body)
        if (form.get('username') === 'alice' && form.get('password') === 'secret') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 200, msg: '登录成功', token: 'jwt-hub-1', success: true }))
        } else {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 500, msg: '用户名或密码错误', success: false }))
        }
        return
      }
      if (url.pathname === '/captchaImage') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 200, msg: 'ok', uuid: 'cap-uuid-1', img: 'aGVsbG8=' }))
        return
      }
      const auth = request.headers.authorization || ''
      state.tokenSeen.push(auth)
      if (auth !== 'Bearer jwt-hub-1') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 401, msg: 'token 失效', success: false }))
        return
      }
      if (url.pathname === '/system/skillhub/skills/search') {
        if (handlers.searchFail) {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 503, msg: '维护中', success: false }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          code: 200, msg: 'ok', success: true, page: Number(url.searchParams.get('page') || 0), size: Number(url.searchParams.get('size') || 20), total: 2,
          has_next: Number(url.searchParams.get('page') || 0) < 2,
          labelStats: [{ label: '开发工具', count: 2 }],
          items: [
            { namespace: 'internal', slug: 'pdf 工具', displayName: 'PDF 工具', summary: '处理 PDF', skillLabel: '开发工具', downloadCount: 10, ratingAvg: 4.5, ratingCount: 2, tags: ['pdf'], createdByName: '张三', publishedVersion: { version: '1.0.0', status: 'PUBLISHED', downloadReady: true } },
            { namespace: 'internal', slug: 'plain', displayName: 'Plain', summary: '', skillLabel: '开发工具', downloadCount: 1, publishedVersion: { version: '2.0.0', status: 'PUBLISHED', downloadReady: true } },
          ],
        }))
        return
      }
      const skillMatch = /^\/system\/skillhub\/skills\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
      if (skillMatch) {
        const [, ns, slug, rest] = skillMatch
        const tail = (rest || '')
        if (tail === '') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 200, msg: 'ok', success: true, namespace: decodeURIComponent(ns), slug: decodeURIComponent(slug), displayName: 'PDF 工具', summary: '处理 PDF', publishedVersion: { version: '1.2.0', status: 'PUBLISHED', downloadReady: true, createdByName: '张三', publishedAt: '2026-03-01T00:00:00Z', totalSize: 20480 } }))
          return
        }
        if (tail === '/versions') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 200, msg: 'ok', success: true, items: [{ version: '1.2.0', status: 'PUBLISHED', changelog: 'c', fileCount: 3, totalSize: 20480, publishedAt: '2026-03-01T00:00:00Z', downloadReady: true, createdByName: '张三' }], page: 0, size: 50, total: 1, has_next: false }))
          return
        }
        if (/^\/versions\/[^/]+\/file$/.test(tail)) {
          if (url.searchParams.get('path') !== 'SKILL.md') {
            response.writeHead(404, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ code: 404, msg: '文件不存在', success: false }))
            return
          }
          response.writeHead(200, { 'content-type': 'application/octet-stream' })
          response.end(Buffer.from('---\nname: pdf 工具\ndescription: 处理 PDF。\n---\n\n# PDF 工具\n', 'utf8'))
          return
        }
        if (/^\/versions\/[^/]+\/download$/.test(tail)) {
          if (handlers.downloadJsonError) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ code: 500, msg: '包损坏', success: false, errorCode: handlers.downloadJsonError }))
            return
          }
          if (handlers.downloadStatus) {
            response.writeHead(handlers.downloadStatus, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ code: handlers.downloadStatus, msg: handlers.downloadMsg || '失败', success: false }))
            return
          }
          const payload = Buffer.from('PK-stub-zip-bytes')
          response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(payload.length) })
          response.end(payload)
          return
        }
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 404, msg: 'not found', success: false }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(res => server.close(res)),
      })
    })
  })
}

async function makeHub(handlers) {
  const hub = await startHubServer(handlers)
  const secrets = { map: new Map(), async get(key) { return this.map.get(key) }, async store(key, value) { this.map.set(key, value) }, async delete(key) { this.map.delete(key) } }
  const auth = createSkillHubAuth({ baseUrl: hub.baseUrl, secrets })
  await auth.login({ username: 'alice', password: 'secret' })
  const transport = createHttpTransport({ baseUrl: hub.baseUrl, auth })
  return { hub, auth, transport, secrets }
}

test('http transport: 登录后 search 注入 Bearer 并按契约解析（has_next snake_case）', async t => {
  const { hub, transport } = await makeHub()
  t.after(() => hub.close())
  const result = await searchSkills(transport, { q: 'pdf', sort: 'downloads', page: 1, size: 20 })
  const search = hub.state.calls.find(call => call.pathname === '/system/skillhub/skills/search')
  assert.ok(search, '请求到达 mock 服务器')
  assert.equal(search.authorization, 'Bearer jwt-hub-1', '携带登录 token')
  assert.equal(search.query.q, 'pdf')
  assert.equal(search.query.sort, 'downloads')
  assert.equal(search.query.page, '1')
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].id, 'internal/pdf 工具', 'skillId 用服务端 namespace/slug 字段')
  assert.equal(result.items[0].version, '1.0.0')
  assert.equal(result.hasNext, true, 'has_next 解析')
  assert.deepEqual(result.labelStats, [{ label: '开发工具', count: 2 }])
})

test('http transport: 未登录请求 401 → UNAUTHORIZED 且 token 被清', async t => {
  const hub = await startHubServer()
  t.after(() => hub.close())
  const secrets = { map: new Map(), async get(key) { return this.map.get(key) }, async store(key, value) { this.map.set(key, value) }, async delete(key) { this.map.delete(key) } }
  const auth = createSkillHubAuth({ baseUrl: hub.baseUrl, secrets })
  const transport = createHttpTransport({ baseUrl: hub.baseUrl, auth })
  await assert.rejects(searchSkills(transport, {}), error => {
    assert.ok(error instanceof MarketError)
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.equal(error.requiresLogin, true)
    return true
  })
  assert.equal(await auth.getToken(), null, '401 后 token 已清（重登由 webview 驱动）')
})

test('http transport: HTTP 状态映射 403/404/5xx', async t => {
  const { hub, transport } = await makeHub({ downloadStatus: 403 })
  t.after(() => hub.close())
  await assert.rejects(fetchDownload(transport, 'internal/plain', '2.0.0'), error => error.code === 'FORBIDDEN')

  const missing = await makeHub()
  t.after(() => missing.hub.close())
  // '/internal' 只有单段，不命中 mock 详情分支 → 落到最终 404
  await assert.rejects(unwrapJson(await missing.transport({ path: '/internal' }), '详情'), error => error.code === 'NOT_FOUND')

  const failing = await makeHub({ searchFail: true })
  t.after(() => failing.hub.close())
  await assert.rejects(searchSkills(failing.transport, {}), error => error.code === 'NETWORK')
})

test('http transport: 下载 zip → bytes + 进度回调；JSON 错误体映射语义码', async t => {
  const { hub, transport } = await makeHub()
  t.after(() => hub.close())
  const progresses = []
  const bytes = await fetchDownload(transport, 'internal/plain', '2.0.0', { onProgress: (loaded, total) => progresses.push([loaded, total]) })
  assert.equal(bytes.toString(), 'PK-stub-zip-bytes')
  assert.deepEqual(progresses, [[17, 17]], 'Content-Length 进度（PK-stub-zip-bytes 17 字节）')

  const broken = await makeHub({ downloadJsonError: 'ARCHIVE_CORRUPT' })
  t.after(() => broken.hub.close())
  await assert.rejects(fetchDownload(broken.transport, 'internal/plain', '2.0.0'), error => {
    assert.equal(error.code, 'ARCHIVE_CORRUPT', 'JSON 错误体 errorCode 优先')
    assert.equal(error.retryable, true)
    return true
  })
})

test('http transport: 详情三接口拼装 + 概览原文（octet-stream → text）', async t => {
  const { hub, transport } = await makeHub()
  t.after(() => hub.close())
  const detail = await fetchSkillDetail(transport, 'internal/pdf 工具', '1.2.0')
  assert.equal(detail.skill.name, 'PDF 工具')
  assert.equal(detail.version, '1.2.0')
  assert.equal(detail.versions.length, 1)
  assert.match(detail.content, /# PDF 工具/, 'SKILL.md 原文渲染为 content')
  const fileCall = hub.state.calls.find(call => /\/file$/.test(call.pathname))
  assert.equal(fileCall.query.path, 'SKILL.md')
  // 路径参数 URL-encode 且服务端解码还原（skillId 含空格与中文）
  const metaCall = hub.state.calls.find(call => call.pathname === '/system/skillhub/skills/internal/pdf 工具')
  assert.ok(metaCall, '解码后路径命中（URL-encode 往返正确）')
})

test('http transport: 超时映射 NETWORK', async t => {
  // 故意不响应的服务器：请求挂起直到 jsonTimeoutMs 超时
  const server = http.createServer(() => { /* 不响应 */ })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(res => server.close(res)))
  const transport = createHttpTransport({ baseUrl: `http://127.0.0.1:${server.address().port}`, jsonTimeoutMs: 60 })
  await assert.rejects(transport({ path: '/search' }), error => {
    assert.equal(error.code, 'NETWORK')
    assert.match(error.message, /超时/)
    return true
  })
})

test('http transport: 需要 baseUrl 与 fetch 实现', () => {
  assert.throws(() => createHttpTransport({ baseUrl: '' }), /baseUrl/)
  const saved = globalThis.fetch
  globalThis.fetch = undefined
  try {
    assert.throws(() => createHttpTransport({ baseUrl: 'http://x' }), /fetch/)
  } finally {
    globalThis.fetch = saved
  }
})
