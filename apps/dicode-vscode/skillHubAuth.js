/**
 * SkillHub 独立鉴权（阶段 4）。
 *
 * 职责（docs/dicode-skill-market.md 第 7 节「鉴权」）：
 * - SkillHub 独立账号体系，不复用 Codex OIDC token；
 * - POST {BASE}/login（form-urlencoded）换 JWT；平台开启验证码时先 GET {BASE}/captchaImage
 *   取 uuid 与图片，登录附带 code/uuid（触发方式阶段 4 实测校准，14 偏离登记）；
 * - token 存 context.secrets（独立 key，与 OIDC token 分开），不入库不落明文；
 * - getAuthHeader 供真实传输注入 Authorization: Bearer <token>；
 * - 401 清 token 后由 webview 驱动重登 + 重发原请求（app.tsx 对 marketAuthState 已就位）；
 *   本模块不做自动重登（密码不落盘，无法静默重试）。
 *
 * 错误口径：登录失败/凭证失效 → UNAUTHORIZED（requiresLogin），连接层失败 → NETWORK。
 */

'use strict'

const { MarketError } = require('./skillMarket')

/** context.secrets 存储键：与 extension.js 的 OIDC TOKEN_KEY 完全分开 */
const SECRETS_KEY = 'dicode.skillhub.jwt'

/** 默认登录/验证码请求超时（JSON 类接口与传输层 15s 口径一致） */
const AUTH_TIMEOUT_MS = 15 * 1000

/**
 * @typedef {Object} SecretsLike VS Code context.secrets 的最小形状
 * @property {(key: string) => Promise<string|undefined>} get
 * @property {(key: string, value: string) => Promise<void>} store
 * @property {(key: string) => Promise<void>} delete
 */

/**
 * @param {string} baseUrl
 * @param {string} pathname 如 /login、/captchaImage
 * @returns {string}
 */
function buildUrl(baseUrl, pathname) {
	const base = String(baseUrl || '').trim().replace(/\/+$/, '')
	if (!base) throw new MarketError('NETWORK', 'SkillHub 基地址未配置')
	return `${base}${pathname}`
}

/**
 * @param {unknown} error fetch 抛出的错误
 * @returns {MarketError}
 */
function toNetworkError(error) {
	if (error instanceof MarketError) return error
	const timedOut = error && (error.name === 'AbortError' || /abort/i.test(String(error.message)))
	return new MarketError('NETWORK', timedOut ? '请求超时' : (error && error.message) || '连接 SkillHub 失败')
}

/**
 * @param {Response} response
 * @param {string} scope
 * @returns {Promise<any>} 解析出的 JSON 体外层
 */
async function readJson(response, scope) {
	const text = await response.text().catch(() => '')
	try {
		return JSON.parse(text)
	} catch {
		throw new MarketError('NETWORK', `${scope}：响应不是合法 JSON`)
	}
}

/**
 * @param {import('node:http').IncomingMessage|Response} response
 * @param {string} scope 登录/验证码等 scope 文案
 */
function assertHttpStatus(response, scope) {
	if (response.status === 401) throw new MarketError('UNAUTHORIZED', '登录已失效')
	if (response.status === 403) throw new MarketError('FORBIDDEN', '账号无权执行该操作')
	if (response.status === 404) throw new MarketError('NOT_FOUND', '接口不存在，请核对基地址')
	if (response.status >= 400) throw new MarketError('NETWORK', `${scope}：HTTP ${response.status}`)
}

/**
 * 创建 SkillHub 鉴权实例。全部网络调用可注入 fetchImpl；测试用桩 secrets/fetch 驱动。
 *
 * @param {Object} options
 * @param {string} options.baseUrl SKILLHUB_BASE_URL（非空）
 * @param {SecretsLike} options.secrets VS Code context.secrets（或测试桩）
 * @param {typeof fetch} [options.fetchImpl] 缺省用全局 fetch（Node 18+ / VS Code 扩展宿主可用）
 * @param {number} [options.timeoutMs]
 * @returns {SkillHubAuth}
 */
function createSkillHubAuth({ baseUrl, secrets, fetchImpl, timeoutMs = AUTH_TIMEOUT_MS }) {
	const base = String(baseUrl || '').trim()
	if (!base) throw new Error('createSkillHubAuth 需要 baseUrl')
	const doFetch = fetchImpl || globalThis.fetch
	if (typeof doFetch !== 'function') throw new Error('环境缺少 fetch 实现')

	/** @returns {Promise<string|null>} */
	async function getToken() {
		const raw = await secrets.get(SECRETS_KEY).catch(() => undefined)
		const token = raw && String(raw).trim()
		return token || null
	}

	/** @returns {Promise<Record<string, string>>} 已登录时返回 Bearer 头，未登录返回空对象 */
	async function getAuthHeader() {
		const token = await getToken()
		return token ? { authorization: `Bearer ${token}` } : {}
	}

	/** 清 token（401 / 登出） */
	async function clearToken() {
		await secrets.delete(SECRETS_KEY).catch(() => {})
	}

	/**
	 * 登录换取 JWT 并存入 secrets。验证码开启时调用方先走 captcha() 再附带 code/uuid。
	 * @param {{ username: string, password: string, code?: string, uuid?: string }} credentials
	 * @returns {Promise<{ username: string }>} 登录成功回执（token 不回传 UI）
	 */
	async function login({ username, password, code, uuid }) {
		const account = String(username || '').trim()
		if (!account || !password) throw new MarketError('UNAUTHORIZED', '请输入账号与密码')
		const form = new URLSearchParams({ username: account, password })
		if (code) form.set('code', code)
		if (uuid) form.set('uuid', uuid)
		let response
		try {
			response = await doFetch(buildUrl(base, '/login'), {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: form.toString(),
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			throw toNetworkError(error)
		}
		assertHttpStatus(response, '登录')
		const body = await readJson(response, '登录')
		if (body && body.success === true && typeof body.token === 'string' && body.token) {
			await secrets.store(SECRETS_KEY, body.token)
			return { username: account }
		}
		// 失败形态（code != 200 / success=false）统一按凭证无效处理，msg 透传给 UI（实测校准项）
		throw new MarketError('UNAUTHORIZED', (body && body.msg) || '登录失败，请核对账号与密码')
	}

	/**
	 * 拉取验证码：GET {BASE}/captchaImage → { uuid, img }。
	 * 平台未开启验证码时该接口可能 404 或返回 captchaEnabled=false —— 都按「无验证码」处理返回 null，
	 * 触发条件实测校准（14 偏离登记）。
	 * @returns {Promise<{ uuid: string, image: string }|null>} image 为 base64 原文（UI 侧拼 data: 前缀）
	 */
	async function captcha() {
		let response
		try {
			response = await doFetch(buildUrl(base, '/captchaImage'), {
				method: 'GET',
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			throw toNetworkError(error)
		}
		if (response.status === 404) return null
		assertHttpStatus(response, '验证码')
		const body = await readJson(response, '验证码')
		if (!body || typeof body.uuid !== 'string' || !body.uuid) return null
		const image = typeof body.img === 'string' ? body.img : (typeof body.image === 'string' ? body.image : '')
		if (!image) return null
		return { uuid: body.uuid, image }
	}

	/** 登出：清 secrets 中的 token（服务端 JWT 无登出接口，本地失效即可） */
	async function logout() {
		await clearToken()
	}

	/** 当前登录态：token 存在即视为已登录（有效性由首个请求的 401 校正） */
	async function isLoggedIn() {
		return (await getToken()) !== null
	}

	return { baseUrl: base, getToken, getAuthHeader, clearToken, login, captcha, logout, isLoggedIn }
}

module.exports = {
	createSkillHubAuth,
	SECRETS_KEY,
	AUTH_TIMEOUT_MS,
}
