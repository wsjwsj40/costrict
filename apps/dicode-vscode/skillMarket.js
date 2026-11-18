/**
 * SkillHub 市场数据源抽象与适配层（阶段 2）。
 *
 * 职责（docs/dicode-skill-market.md 第 5.1、6、7 节）：
 * - 传输抽象：消费 `async ({ path, query, method, body }) => { status, contentType, text }` 形状的
 *   transport；桩（marketStub.js）与阶段 4 的真实 HTTP 传输共用同一出口，UI 不感知来源。
 * - 适配层：服务端字段 → UI 模型 MarketSkill（5.1），映射差异不泄漏到 webview。
 * - 错误映射：HTTP 状态与 JSON 错误体 → 7.1 错误码（401→UNAUTHORIZED、403→FORBIDDEN、404→NOT_FOUND、
 *   连接失败/5xx→NETWORK），retryable 口径与 skillsModel.errorInfo 一致。
 * - has_next / hasNext 两种写法兼容（阶段 4 实测确认哪种）。
 *
 * 目录缓存在本模块随阶段 2 任务 3 增加（market-cache.json，q+label+sort 分组）。
 */

'use strict'

const { errorInfo } = require('./skillsModel')

/** 7.1 中市场请求可能产出的错误码，retryable 由 skillsModel 统一裁决 */
class MarketError extends Error {
	/**
	 * @param {string} code 7.1 错误码
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || errorInfo(code).message)
		/** @type {string} */
		this.code = code
		/** @type {boolean} */
		this.retryable = errorInfo(code).retryable
		if (errorInfo(code).requiresLogin) this.requiresLogin = true
	}
}

/**
 * skillId = `${namespace}/${slug}`；路径参数一律取自查询结果字段并 URL-encode（第 7 节）。
 * @param {string} skillId
 * @returns {[string, string]}
 */
function splitSkillId(skillId) {
	const index = String(skillId || '').indexOf('/')
	if (index <= 0 || index === String(skillId).length - 1) throw new MarketError('NOT_FOUND', `skillId 非法：${skillId}`)
	return [skillId.slice(0, index), skillId.slice(index + 1)]
}

const COMPAT_VALUES = new Set(['compatible', 'incompatible', 'restricted'])

/** @param {unknown} value */
function pickCompat(value) {
	return typeof value === 'string' && COMPAT_VALUES.has(value) ? value : 'compatible'
}

/** @param {string|null|undefined} iso ISO 时间字符串 → 毫秒时间戳，非法给 undefined */
function toTimestamp(iso) {
	const value = Date.parse(String(iso || ''))
	return Number.isFinite(value) ? value : undefined
}

/**
 * 服务端列表/详情条目 → UI 模型（5.1 MarketSkill）。
 * 版本取 publishedVersion.version：列表接口不返回 → 空态 ''，详情缓存回填（14 #15）。
 * compat 接口无字段：默认 compatible；桩私有 compat 字段存在且合法才采用（14 #20）。
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>} MarketSkill
 */
function adaptSkill(raw) {
	if (!raw || typeof raw !== 'object') throw new MarketError('NOT_FOUND', '响应缺少条目字段')
	const labels = Array.isArray(raw.labels) && raw.labels.length ? raw.labels : raw.skillLabel ? [raw.skillLabel] : []
	return {
		id: `${raw.namespace}/${raw.slug}`,
		namespace: String(raw.namespace || ''),
		slug: String(raw.slug || ''),
		name: String(raw.displayName || raw.slug || ''),
		publisher: String(raw.createdByName || ''),
		publisherDept: String(raw.createdByDept || ''),
		version: raw.publishedVersion && raw.publishedVersion.version ? String(raw.publishedVersion.version) : '',
		summary: String(raw.summary || ''),
		tags: labels.map(String),
		icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : undefined,
		needApiKey: raw.needApiKey === true,
		compat: pickCompat(raw.compat),
		minClientVersion: raw.minClientVersion ? String(raw.minClientVersion) : undefined,
		compatReason: raw.compatReason ? String(raw.compatReason) : undefined,
		updatedAt: toTimestamp(raw.updatedAt),
		downloadCount: Number(raw.downloadCount) || 0,
		starCount: Number(raw.starCount) || 0,
		ratingAvg: typeof raw.ratingAvg === 'number' ? raw.ratingAvg : undefined,
		ratingCount: Number(raw.ratingCount) || 0,
		/** 桩私有：阶段 3 桩包选择用，真实接口恒为 undefined */
		stubInstallCase: raw.stubInstallCase || undefined,
	}
}

/**
 * 版本列表条目透传（安装门禁 status === 'PUBLISHED' && downloadReady === true 由 UI 判定）。
 * @param {Record<string, any>} raw
 */
function adaptVersion(raw) {
	return {
		version: String(raw.version || ''),
		status: String(raw.status || ''),
		changelog: String(raw.changelog || ''),
		fileCount: Number(raw.fileCount) || 0,
		totalSize: Number(raw.totalSize) || 0,
		publishedAt: toTimestamp(raw.publishedAt),
		downloadReady: raw.downloadReady === true,
		createdByName: String(raw.createdByName || ''),
	}
}

/**
 * HTTP 响应 → JSON 对象或文本。错误按 7.1 映射，成功看 success == true（不看 code）。
 * @param {{ status: number, contentType: string, text: string }} response
 * @param {string} scope 用于错误信息定位
 * @returns {Promise<any>}
 */
async function unwrapJson(response, scope) {
	const { status, contentType, text } = response
	let body = null
	const isJson = /json/i.test(String(contentType))
	if (isJson) {
		try {
			body = JSON.parse(text)
		} catch {
			throw new MarketError('NETWORK', `${scope}：响应不是合法 JSON`)
		}
	}
	if (status === 401 || (body && body.success === false && Number(body.code) === 401)) throw new MarketError('UNAUTHORIZED', body && body.msg)
	if (status === 403 || (body && body.success === false && Number(body.code) === 403)) throw new MarketError('FORBIDDEN', body && body.msg)
	if (status === 404 || (body && body.success === false && Number(body.code) === 404)) throw new MarketError('NOT_FOUND', body && body.msg)
	if (status >= 500 || (body && body.success === false)) {
		// JSON 错误体可能自带 7.1 语义码（如下载的 CRC/来源校验），优先采用
		const known = body && typeof body.errorCode === 'string' && body.errorCode
		throw new MarketError(known || 'NETWORK', body && body.msg)
	}
	if (!isJson) return { text }
	if (!body || body.success !== true) throw new MarketError('NETWORK', `${scope}：响应缺少 success 标记`)
	return body
}

/**
 * 目录分页请求（/search 语义）。page 从 0 开始；has_next/hasNext 双兼容。
 * @param {(request: { path: string, query?: Record<string, string>, method?: string, body?: any }) => Promise<{ status: number, contentType: string, text: string }>} transport
 * @param {{ q?: string, label?: string, sort?: string, page?: number, size?: number }} params
 */
async function searchSkills(transport, params = {}) {
	const query = {}
	if (params.q) query.q = params.q
	if (params.label) query.label = params.label
	if (params.sort) query.sort = params.sort
	query.page = String(Math.max(0, params.page || 0))
	query.size = String(Math.max(1, params.size || 20))
	let body
	try {
		body = await unwrapJson(await transport({ path: '/search', query }), '目录请求')
	} catch (error) {
		if (error instanceof MarketError) throw error
		throw new MarketError('NETWORK', error && error.message)
	}
	const items = (Array.isArray(body.items) ? body.items : []).map(adaptSkill)
	const hasNext = body.has_next !== undefined ? body.has_next === true : body.hasNext === true
	return {
		items,
		page: Number(body.page) || 0,
		size: Number(body.size) || 20,
		total: Number(body.total) || 0,
		hasNext: hasNext === true,
		labelStats: (Array.isArray(body.labelStats) ? body.labelStats : []).map(entry => ({ label: String(entry.label), count: Number(entry.count) || 0 })),
	}
}

const OVERVIEW_PATH = 'SKILL.md'

/** 下载超时下限（第 7 节：应用服务器流式传输，≥60s），由 transport 实现方执行 */
const DOWNLOAD_TIMEOUT_MS = 60 * 1000

/**
 * 下载指定版本技能包（8.1 步骤 3，固定版本下载入口，不用最新版接口）。
 * Content-Type 分流：application/json → 按 7.1 映射错误（含 body.errorCode 语义码）；
 * 其余按二进制返回 bytes。transport 契约扩展：响应可带 bytes（Uint8Array/Buffer），
 * 请求可带 timeoutMs（真实传输执行超时）与 onProgress(loaded, total)（流式实现回调）。
 * @param {(request: { path: string, query?: Record<string, string>, method?: string, timeoutMs?: number, onProgress?: (loaded: number, total: number) => void }) => Promise<{ status: number, contentType: string, text?: string, bytes?: Uint8Array }>} transport
 * @param {string} skillId
 * @param {string} version
 * @param {{ timeoutMs?: number, onProgress?: (loaded: number, total: number) => void }} [options]
 * @returns {Promise<Buffer>} zip 原始字节
 */
async function fetchDownload(transport, skillId, version, options = {}) {
	const [ns, slug] = splitSkillId(skillId)
	const enc = value => encodeURIComponent(value)
	/** @type {{ path: string, method: string, timeoutMs: number, onProgress?: (loaded: number, total: number) => void }} */
	const request = {
		path: `/${enc(ns)}/${enc(slug)}/versions/${enc(version)}/download`,
		method: 'GET',
		timeoutMs: options.timeoutMs || DOWNLOAD_TIMEOUT_MS,
	}
	if (options.onProgress) request.onProgress = options.onProgress
	let response
	try {
		response = await transport(request)
	} catch (error) {
		if (error instanceof MarketError) throw error
		throw new MarketError('NETWORK', error && error.message)
	}
	const contentType = String(response.contentType || '')
	if (response.status !== 200 || /json/i.test(contentType)) {
		// JSON 错误体按统一口径映射（401/403/404/语义码/5xx）；走完未抛说明是 200 的 JSON 成功体，
		// 下载接口不应返回 JSON 成功响应，按协议异常处理
		await unwrapJson(response, '下载请求')
		throw new MarketError('NETWORK', '下载请求：下载接口返回了 JSON 响应')
	}
	const bytes = response.bytes !== undefined
		? Buffer.from(response.bytes)
		: Buffer.from(String(response.text || ''), 'binary')
	if (!bytes.length) throw new MarketError('ARCHIVE_CORRUPT', '下载内容为空')
	return bytes
}

/**
 * 市场详情：三个接口拼装，不下载包即可查看（3.3）。
 * version 缺省取 publishedVersion.version；仅该版本的概览原文被拉取。
 * @param {typeof transport} transport
 * @param {string} skillId
 * @param {string} [version] 缺省用详情的 publishedVersion.version
 * @returns {Promise<{ skill: Record<string, any>, content: string, versions: Array<Record<string, any>>, version: string }>}
 */
async function fetchSkillDetail(transport, skillId, version) {
	const [ns, slug] = splitSkillId(skillId)
	const enc = value => encodeURIComponent(value)
	let meta
	try {
		meta = await unwrapJson(await transport({ path: `/${enc(ns)}/${enc(slug)}` }), '详情请求')
	} catch (error) {
		if (error instanceof MarketError) throw error
		throw new MarketError('NETWORK', error && error.message)
	}
	const skill = adaptSkill(meta)
	const resolvedVersion = version || skill.version
	if (!resolvedVersion) throw new MarketError('NOT_FOUND', '该技能暂无已发布版本')

	const versionsBody = await unwrapJson(await transport({ path: `/${enc(ns)}/${enc(slug)}/versions`, query: { page: '0', size: '50' } }), '版本列表')
	const versions = (Array.isArray(versionsBody.items) ? versionsBody.items : []).map(adaptVersion)

	const overview = await unwrapJson(await transport({ path: `/${enc(ns)}/${enc(slug)}/versions/${enc(resolvedVersion)}/file`, query: { path: OVERVIEW_PATH } }), '概览请求')
	return { skill, content: String(overview.text || ''), versions, version: resolvedVersion }
}

// ---------------------------------------------------------------------------
// 目录缓存（第 7 节「分页与缓存」）
// ---------------------------------------------------------------------------

const fs = require('node:fs/promises')
const nodePath = require('node:path')

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_GROUPS = 20
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/**
 * 稳定分组键：q + label + sort（sort 缺省归一为 newest，与请求语义一致）。
 * @param {{ q?: string, label?: string, sort?: string }} params
 */
function groupKeyOf(params) {
	return JSON.stringify([params.q || '', params.label || '', params.sort || 'newest'])
}

function emptyCache() {
	return { version: 1, groups: {} }
}

/**
 * @param {Object} options
 * @param {string} options.cacheFile 缓存文件绝对路径（globalStorageUri 下 market-cache.json，全局一份）
 * @param {() => number} [options.now] 可注入时钟（测试用）
 * @param {number} [options.ttlMs] 过期阈值，默认 10 分钟
 * @param {number} [options.maxGroups] 分组上限，默认 20
 * @param {number} [options.maxBytes] 文件总量上限，默认 2 MB
 */
function createCatalogCache({ cacheFile, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxGroups = DEFAULT_MAX_GROUPS, maxBytes = DEFAULT_MAX_BYTES }) {
	/** @type {ReturnType<typeof emptyCache>|null} */
	let memo = null

	async function load() {
		if (memo) return memo
		let parsed = null
		try {
			parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
		} catch {
			// 不存在或损坏：损坏时留 .bak，按空缓存继续
			try {
				await fs.copyFile(cacheFile, cacheFile + '.bak')
			} catch { /* 不存在则无需备份 */ }
			memo = emptyCache()
			return memo
		}
		memo = parsed && typeof parsed === 'object' && parsed.groups && typeof parsed.groups === 'object' ? parsed : emptyCache()
		return memo
	}

	async function persist() {
		if (!memo) return
		const tmp = cacheFile + '.tmp'
		await fs.mkdir(nodePath.dirname(cacheFile), { recursive: true })
		await fs.writeFile(tmp, JSON.stringify(memo))
		await fs.rename(tmp, cacheFile)
	}

	/** 组数与字节数超限时按 lastUsed 淘汰最旧分组 */
	function evict() {
		if (!memo) return
		const entries = Object.entries(memo.groups)
		const sizeOf = ([, group]) => JSON.stringify(group).length
		let totalBytes = entries.reduce((sum, entry) => sum + sizeOf(entry), 0)
		const oldest = () => entries.slice().sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0))[0]
		while (entries.length > maxGroups || totalBytes > maxBytes) {
			const victim = oldest()
			if (!victim) break
			totalBytes -= sizeOf(victim)
			entries.splice(entries.findIndex(entry => entry[0] === victim[0]), 1)
			delete memo.groups[victim[0]]
		}
	}

	/** 读页缓存并刷新组 lastUsed（touch 落盘，重启后 LRU 顺序不失真） */
	async function readPage(key, page) {
		const cache = await load()
		const group = cache.groups[key]
		const page_ = group && group.pages && group.pages[String(page)]
		if (!page_) return null
		group.lastUsed = now()
		await persist()
		return page_
	}

	async function writePage(key, page, result) {
		const cache = await load()
		const group = cache.groups[key] || (cache.groups[key] = { lastUsed: 0, pages: {} })
		group.lastUsed = now()
		const entry = { ...result, cachedAt: now() }
		group.pages[String(page)] = entry
		evict()
		await persist()
		return entry
	}

	/**
	 * 带缓存的目录请求。
	 * @param {{ q?: string, label?: string, sort?: string, page?: number, size?: number }} params
	 * @param {(params: typeof params) => Promise<Record<string, any>>} fetcher 无缓存获取（searchSkills）
	 * @param {{ force?: boolean }} [options] force: 绕过读缓存直接拉新并覆盖写入（后台刷新用）
	 * @returns {Promise<Record<string, any>>} searchSkills 结果 + stale + cachedAt + query/label/sort 回带
	 */
	async function search(params, fetcher, options = {}) {
		const page = Math.max(0, params.page || 0)
		const key = groupKeyOf(params)
		if (options.force !== true) {
			const cached = await readPage(key, page)
			if (cached) {
				const fresh = now() - cached.cachedAt < ttlMs
				return { ...cached, stale: !fresh, query: params.q || '', label: params.label || '', sort: params.sort || 'newest' }
			}
		}
		const result = await fetcher(params)
		const entry = await writePage(key, page, result)
		return { ...entry, stale: false, query: params.q || '', label: params.label || '', sort: params.sort || 'newest' }
	}

	/** 清空缓存（测试与「忽略缓存重试」用） */
	async function clear() {
		memo = emptyCache()
		await persist()
	}

	return { search, clear, groupKeyOf }
}

module.exports = {
	MarketError,
	splitSkillId,
	adaptSkill,
	adaptVersion,
	unwrapJson,
	searchSkills,
	fetchSkillDetail,
	fetchDownload,
	createCatalogCache,
	groupKeyOf,
	DOWNLOAD_TIMEOUT_MS,
	DEFAULT_TTL_MS,
	DEFAULT_MAX_GROUPS,
	DEFAULT_MAX_BYTES,
	OVERVIEW_PATH,
}
