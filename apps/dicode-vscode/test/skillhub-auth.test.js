'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createSkillHubAuth, SECRETS_KEY } = require('../skillHubAuth')
const { MarketError } = require('../skillMarket')

/** secrets 桩：内存 Map 模拟 context.secrets（方法名对齐 VS Code API） */
function makeSecretStore() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.get(key) },
    async store(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
  }
}

/** fetch 桩：按注册的路径返回固定响应对象（status/text/body） */
function makeFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    calls.push({ path, init })
    const route = routes.find(item => item.path === path && (!item.method || item.method === (init && init.method || 'GET')))
    if (!route) throw new Error(`fetch 桩未注册路径：${path}`)
    if (route.reject) throw route.reject
    return {
      status: route.status || 200,
      text: async () => typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
    }
  }
  return { impl, calls }
}

function makeAuth(routes, overrides = {}) {
  const secrets = makeSecretStore()
  const fetch = makeFetch(routes)
  const auth = createSkillHubAuth({ baseUrl: 'http://hub.test', secrets, fetchImpl: fetch.impl, ...overrides })
  return { auth, secrets, fetch }
}

test('auth: createSkillHubAuth 需要非空 baseUrl', () => {
  assert.throws(() => createSkillHubAuth({ baseUrl: '  ', secrets: makeSecretStore() }), /baseUrl/)
})

test('auth: 登录成功换取 token 存 secrets 且不回传明文', async () => {
  const { auth, secrets, fetch } = makeAuth([
    { path: '/login', method: 'POST', body: { code: 200, msg: '登录成功', token: 'jwt-abc', success: true } },
  ])
  const result = await auth.login({ username: ' alice ', password: 'pw' })
  assert.equal(result.username, 'alice', '用户名去空白回传')
  assert.equal(await secrets.get(SECRETS_KEY), 'jwt-abc')
  assert.equal(await auth.isLoggedIn(), true)
  assert.deepEqual(await auth.getAuthHeader(), { authorization: 'Bearer jwt-abc' })
  // form-urlencoded 且不含 token
  const init = fetch.calls[0].init
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(init.body, 'username=alice&password=pw')
  assert.ok(!JSON.stringify(result).includes('jwt-abc'), '回执不携带 token')
})

test('auth: 登录附带验证码 code/uuid', async () => {
  const { auth, fetch } = makeAuth([
    { path: '/login', method: 'POST', body: { code: 200, token: 't', success: true } },
  ])
  await auth.login({ username: 'u', password: 'p', code: '8888', uuid: 'cap-1' })
  assert.equal(fetch.calls[0].init.body, 'username=u&password=p&code=8888&uuid=cap-1')
})

test('auth: 登录失败透传服务端 msg 并抛 UNAUTHORIZED', async () => {
  const { auth } = makeAuth([
    { path: '/login', method: 'POST', body: { code: 500, msg: '用户不存在或密码错误', success: false } },
  ])
  await assert.rejects(auth.login({ username: 'u', password: 'bad' }), error => {
    assert.ok(error instanceof MarketError)
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.equal(error.message, '用户不存在或密码错误')
    return true
  })
})

test('auth: 缺账号密码直接拒绝，不发起请求', async () => {
  const { auth, fetch } = makeAuth([])
  await assert.rejects(auth.login({ username: '', password: '' }), MarketError)
  assert.equal(fetch.calls.length, 0)
})

test('auth: captcha 返回 uuid 与图片；404 或缺字段按未开启处理', async () => {
  const enabled = makeAuth([{ path: '/captchaImage', body: { code: 200, uuid: 'u-1', img: 'YmFzZTY0' } }])
  assert.deepEqual(await enabled.auth.captcha(), { uuid: 'u-1', image: 'YmFzZTY0' })

  const disabled = makeAuth([{ path: '/captchaImage', status: 404 }])
  assert.equal(await disabled.auth.captcha(), null)

  const malformed = makeAuth([{ path: '/captchaImage', body: { code: 200 } }])
  assert.equal(await malformed.auth.captcha(), null)
})

test('auth: 登出清 token；isLoggedIn 恢复 false', async () => {
  const { auth, secrets } = makeAuth([
    { path: '/login', method: 'POST', body: { code: 200, token: 't-1', success: true } },
  ])
  await auth.login({ username: 'u', password: 'p' })
  assert.equal(await auth.isLoggedIn(), true)
  await auth.logout()
  assert.equal(await secrets.get(SECRETS_KEY), undefined)
  assert.equal(await auth.isLoggedIn(), false)
  assert.deepEqual(await auth.getAuthHeader(), {})
})

test('auth: 网络失败映射 NETWORK；超时文案可辨识', async () => {
  const offline = makeAuth([{ path: '/login', method: 'POST', reject: new Error('ECONNREFUSED') }])
  await assert.rejects(offline.auth.login({ username: 'u', password: 'p' }), error => error.code === 'NETWORK')

  const timeout = makeAuth([{ path: '/login', method: 'POST', reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) }])
  await assert.rejects(timeout.auth.login({ username: 'u', password: 'p' }), error => {
    assert.equal(error.code, 'NETWORK')
    assert.match(error.message, /超时/)
    return true
  })
})

test('auth: 非 2xx 状态映射（401/403/404/5xx）', async () => {
  const cases = [
    [[{ path: '/login', method: 'POST', status: 401, body: { code: 401 } }], 'UNAUTHORIZED'],
    [[{ path: '/login', method: 'POST', status: 403, body: { code: 403 } }], 'FORBIDDEN'],
    [[{ path: '/login', method: 'POST', status: 404, body: { code: 404 } }], 'NOT_FOUND'],
    [[{ path: '/login', method: 'POST', status: 500, body: { code: 500 } }], 'NETWORK'],
  ]
  let index = 0
  for (const [routes, expected] of cases) {
    const { auth } = makeAuth(routes)
    await assert.rejects(auth.login({ username: 'u', password: 'p' }), error => {
      assert.equal(error.code, expected, `case ${index}`)
      return true
    })
    index += 1
  }
})
