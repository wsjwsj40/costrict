/**
 * SkillHub 市场桩数据（阶段 2）。
 *
 * 响应形状逐字段对照 docs/skillhub-api.md：
 * - 成功以 success == true 判定，业务字段与 code 平级（不在 data 下）
 * - 列表：items/total/page/size/labelStats/has_next
 * - 详情：业务字段平级，publishedVersion 指向当前发布版本
 * - 版本列表：items 按 publishedAt 倒序，安装门禁 status === 'PUBLISHED' && downloadReady === true
 * - 概览：application/octet-stream，body 为 SKILL.md UTF-8 原文（无 JSON 包装）
 * - 失败：JSON 错误体 success == false
 *
 * 桩只负责「数据与状态字段」，不模拟安装动作（7.2）：安装由阶段 3 管道 + 本地桩包驱动。
 * 兼容/组织限制字段（compat/compatReason/minClientVersion）与 stubInstallCase 为桩私有附加字段，
 * 真实接口没有对应字段（14 #20），适配层按「存在才用、缺省 compatible」处理。
 *
 * 对外暴露 createTransport(state)：返回与真实 HTTP 传输同形的 async (request) => { status, contentType, text }，
 * 供 skillMarket.js 数据源抽象统一消费；阶段 4 只替换 transport 实现。
 */

'use strict'

const archive = require('./skillArchive')

const STUB_ACCOUNT = { username: 'admin', password: 'admin123' }

const TINY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * 阶段 3 桩包用例标记（本阶段仅备字段，不消费）。
 * @typedef {'crc-corrupt'|'source-verify'|'incompatible'|'org-restricted'|'missing-skillmd'|'oversize'} StubInstallCase
 */

/**
 * @typedef {Object} StubSkill
 * @property {number} id
 * @property {string} slug
 * @property {string} displayName
 * @property {string} summary
 * @property {string} skillLabel
 * @property {boolean} needApiKey
 * @property {'compatible'|'incompatible'|'restricted'} [compat] 桩私有：真实接口无此字段
 * @property {string} [compatReason] 桩私有
 * @property {string} [minClientVersion] 桩私有
 * @property {StubInstallCase} [stubInstallCase] 桩私有：阶段 3 选桩包用
 * @property {Array<{ version: string, status: 'PUBLISHED'|'DRAFT', changelog: string, fileCount: number, totalSize: number, publishedAt: string, downloadReady: boolean }>} versions
 * @property {string} overview SKILL.md 原文
 */

/** @type {StubSkill[]} 覆盖五态：1/2/5/6/7/8 可安装，4 incompatible，3 restricted；secret-skill 走 403 */
const STUB_SKILLS = [
	{
		id: 1,
		slug: 'pdf-tools',
		displayName: 'PDF 工具',
		summary: '拆分、合并、提取 PDF 页面与文本，生成阅读版摘要。',
		skillLabel: '文档处理',
		needApiKey: false,
		versions: [
			{ version: '1.2.0', status: 'PUBLISHED', changelog: '支持批量提取扫描件文本', fileCount: 5, totalSize: 102400, publishedAt: '2026-03-01T10:00:00Z', downloadReady: true },
			{ version: '1.1.0', status: 'PUBLISHED', changelog: '修复中文文件名乱码', fileCount: 5, totalSize: 99300, publishedAt: '2026-01-15T10:00:00Z', downloadReady: true },
		],
		overview: '---\nname: pdf-tools\ndescription: 拆分、合并、提取 PDF 页面与文本。\n---\n\n# PDF 工具\n\n对工作区里的 PDF 执行拆分、合并与文本提取。\n\n## 用法\n\n告诉 Agent 目标文件与操作，例如「把 report.pdf 拆成每章一个文件」。',
	},
	{
		id: 2,
		slug: 'code-review',
		displayName: '代码评审',
		summary: '按团队规范检查变更差异，输出分级评审意见。',
		skillLabel: '代码质量',
		needApiKey: true,
		versions: [
			{ version: '2.0.1', status: 'PUBLISHED', changelog: '新增安全项检查清单', fileCount: 8, totalSize: 204800, publishedAt: '2026-03-10T08:00:00Z', downloadReady: true },
			{ version: '2.0.0', status: 'PUBLISHED', changelog: '规则引擎重构', fileCount: 8, totalSize: 198000, publishedAt: '2026-02-01T08:00:00Z', downloadReady: true },
		],
		overview: '---\nname: code-review\ndescription: 按团队规范检查变更差异。\n---\n\n# 代码评审\n\n对当前分支差异执行分级评审：阻塞、建议、可选。\n\n需要配置模型 API Key 后运行。',
	},
	{
		id: 3,
		slug: 'org-report',
		displayName: '部门周报',
		summary: '汇总本周任务与风险，生成部门周报草稿。',
		skillLabel: '文档处理',
		needApiKey: false,
		compat: 'restricted',
		compatReason: '该部门未授权使用此技能',
		versions: [
			{ version: '0.9.0', status: 'PUBLISHED', changelog: '内部试用版', fileCount: 3, totalSize: 40960, publishedAt: '2026-02-20T09:00:00Z', downloadReady: true },
		],
		overview: '---\nname: org-report\ndescription: 汇总本周任务与风险生成周报。\n---\n\n# 部门周报\n\n按模板汇总本周任务、进度与风险。仅限授权部门使用。',
	},
	{
		id: 4,
		slug: 'legacy-export',
		displayName: '旧版数据导出',
		summary: '导出旧格式项目数据并转换为新结构。',
		skillLabel: '数据迁移',
		needApiKey: false,
		compat: 'incompatible',
		minClientVersion: '1.5.0',
		versions: [
			{ version: '1.0.0', status: 'PUBLISHED', changelog: '首个发布版', fileCount: 6, totalSize: 153600, publishedAt: '2026-01-05T12:00:00Z', downloadReady: true },
		],
		overview: '---\nname: legacy-export\ndescription: 导出旧格式项目数据。\n---\n\n# 旧版数据导出\n\n读取 legacy/ 目录并转换为新结构。需要 1.5.0 及以上客户端。',
	},
	{
		id: 5,
		slug: 'web-scraper',
		displayName: '网页抓取',
		summary: '抓取公开页面正文与表格，保存为结构化数据。',
		skillLabel: '自动化',
		needApiKey: false,
		versions: [
			{ version: '1.3.0', status: 'DRAFT', changelog: '渲染模式重写（草稿中）', fileCount: 9, totalSize: 220000, publishedAt: '2026-03-12T15:00:00Z', downloadReady: false },
			{ version: '1.2.3', status: 'PUBLISHED', changelog: '修复编码问题', fileCount: 7, totalSize: 209000, publishedAt: '2026-03-06T15:00:00Z', downloadReady: true },
			{ version: '1.2.2', status: 'PUBLISHED', changelog: '修复分页遗漏', fileCount: 7, totalSize: 210000, publishedAt: '2026-03-02T15:00:00Z', downloadReady: true },
			{ version: '1.2.1', status: 'PUBLISHED', changelog: '压缩包结构精简', fileCount: 7, totalSize: 208000, publishedAt: '2026-02-10T15:00:00Z', downloadReady: false },
		],
		overview: '---\nname: web-scraper\ndescription: 抓取公开页面正文与表格。\n---\n\n# 网页抓取\n\n输入 URL 列表，输出正文与表格的结构化结果。仅抓取公开页面。',
	},
	{
		id: 6,
		slug: 'sql-explain',
		displayName: 'SQL 解释器',
		summary: '解读执行计划，给出索引与改写建议。',
		skillLabel: '数据库',
		needApiKey: false,
		versions: [
			{ version: '1.0.3', status: 'PUBLISHED', changelog: '补充 MySQL 8 计划节点', fileCount: 4, totalSize: 81920, publishedAt: '2026-03-05T11:00:00Z', downloadReady: true },
		],
		overview: '---\nname: sql-explain\ndescription: 解读 SQL 执行计划。\n---\n\n# SQL 解释器\n\n粘贴 EXPLAIN 输出，获得索引与改写建议。',
	},
	{
		id: 7,
		slug: 'changelog-writer',
		displayName: '变更日志',
		summary: '从提交与差异生成面向用户的变更日志。',
		skillLabel: '文档处理',
		needApiKey: false,
		versions: [
			{ version: '1.1.0', status: 'PUBLISHED', changelog: '支持 SemVer 分组', fileCount: 3, totalSize: 51200, publishedAt: '2026-03-08T16:00:00Z', downloadReady: true },
		],
		overview: '---\nname: changelog-writer\ndescription: 从提交与差异生成变更日志。\n---\n\n# 变更日志\n\n按 SemVer 分组输出用户可读的变更说明。',
	},
	{
		id: 8,
		slug: 'api-mocker',
		displayName: 'API 模拟服务',
		summary: '从接口文档生成可运行的 Mock 服务。',
		skillLabel: '开发工具',
		needApiKey: true,
		stubInstallCase: 'crc-corrupt',
		versions: [
			{ version: '0.5.0', status: 'PUBLISHED', changelog: '最小可用版', fileCount: 10, totalSize: 180000, publishedAt: '2026-03-11T14:00:00Z', downloadReady: true },
		],
		overview: '---\nname: api-mocker\ndescription: 从接口文档生成 Mock 服务。\n---\n\n# API 模拟服务\n\n读取 OpenAPI 文档并启动本地 Mock 服务。',
	},
	{
		id: 9,
		slug: 'secret-skill',
		displayName: '内部审计技能',
		summary: '导出平台审计数据（受限资源）。',
		skillLabel: '开发工具',
		needApiKey: false,
		versions: [
			{ version: '1.0.0', status: 'PUBLISHED', changelog: '受限发布', fileCount: 2, totalSize: 20480, publishedAt: '2026-03-01T00:00:00Z', downloadReady: true },
		],
		overview: '---\nname: secret-skill\ndescription: 导出平台审计数据。\n---\n\n# 内部审计技能\n\n需要平台单独授权后使用。',
	},
	{
		id: 10,
		slug: 'verify-mismatch',
		displayName: '校验用例',
		summary: '来源校验用例：包内 SKILL.md 身份与目录项不一致。',
		skillLabel: '开发工具',
		needApiKey: false,
		stubInstallCase: 'source-verify',
		versions: [
			{ version: '1.0.0', status: 'PUBLISHED', changelog: '校验用例', fileCount: 2, totalSize: 4096, publishedAt: '2026-03-14T10:00:00Z', downloadReady: true },
		],
		overview: '---\nname: verify-mismatch\ndescription: 来源校验用例。\n---\n\n# 校验用例\n\n安装管道应拒绝本包并报 SOURCE_VERIFY_FAILED。',
	},
	{
		id: 11,
		slug: 'broken-pkg',
		displayName: '坏包用例',
		summary: '包结构用例：压缩包缺少 SKILL.md。',
		skillLabel: '开发工具',
		needApiKey: false,
		stubInstallCase: 'missing-skillmd',
		versions: [
			{ version: '1.0.0', status: 'PUBLISHED', changelog: '坏包用例', fileCount: 1, totalSize: 512, publishedAt: '2026-03-14T11:00:00Z', downloadReady: true },
		],
		overview: '---\nname: broken-pkg\ndescription: 坏包用例。\n---\n\n# 坏包用例\n\n安装管道应拒绝本包并报 ARCHIVE_INVALID。',
	},
	{
		id: 12,
		slug: 'heavy-pkg',
		displayName: '超限用例',
		summary: '限额用例：包声明解压体积超过单文件上限。',
		skillLabel: '开发工具',
		needApiKey: false,
		stubInstallCase: 'oversize',
		versions: [
			{ version: '1.0.0', status: 'PUBLISHED', changelog: '超限用例', fileCount: 2, totalSize: 1024, publishedAt: '2026-03-14T12:00:00Z', downloadReady: true },
		],
		overview: '---\nname: heavy-pkg\ndescription: 超限用例。\n---\n\n# 超限用例\n\n安装管道应拒绝本包并报 ARCHIVE_TOO_LARGE。',
	},
]

/** @param {StubSkill} skill */
function searchItem(skill) {
	const latest = skill.versions.filter(item => item.status === 'PUBLISHED')[0]
	const publishedAt = latest ? latest.publishedAt : ''
	const item = {
		id: skill.id,
		slug: skill.slug,
		displayName: skill.displayName,
		summary: skill.summary,
		icon: TINY_ICON,
		status: 'ACTIVE',
		visibility: 'PUBLIC',
		downloadCount: 40 + skill.id * 7,
		starCount: 1 + (skill.id % 5),
		ratingAvg: Math.round((3.5 + (skill.id % 3) * 0.4) * 10) / 10,
		ratingCount: 3 + skill.id,
		namespace: 'global',
		skillLabel: skill.skillLabel,
		needApiKey: skill.needApiKey,
		createdByName: '张三',
		createdByDept: 'AI平台部',
		createdAt: '2026-01-01T10:00:00Z',
		updatedAt: publishedAt,
	}
	// 桩私有附加字段：适配层按「存在才用」透传（14 #20）
	if (skill.compat) item.compat = skill.compat
	if (skill.compatReason) item.compatReason = skill.compatReason
	if (skill.minClientVersion) item.minClientVersion = skill.minClientVersion
	if (skill.stubInstallCase) item.stubInstallCase = skill.stubInstallCase
	return item
}

/** @param {StubSkill} skill */
function detailBody(skill) {
	const published = skill.versions.find(item => item.status === 'PUBLISHED' && item.downloadReady) || skill.versions.filter(item => item.status === 'PUBLISHED')[0]
	const body = searchItem(skill)
	body.namespaces = ['global']
	body.labels = [skill.skillLabel]
	body.headlineVersion = published ? { id: skill.id * 10, version: published.version, status: published.status } : null
	body.publishedVersion = published ? { id: skill.id * 10, version: published.version, status: published.status } : null
	return body
}

/**
 * 创建桩会话状态。extension.js 持有一份，marketLogin/marketLogout 经此切换。
 * @param {Object} [overrides]
 * @returns {{ loggedIn: boolean, username: string, catalogFailure: boolean, unauthorized: boolean, captchaRequired: boolean }}
 */
function createStubState(overrides = {}) {
	return {
		loggedIn: true,
		username: STUB_ACCOUNT.username,
		catalogFailure: false,
		unauthorized: false,
		captchaRequired: false,
		/** slug → 已失败下载次数；crc-corrupt 桩包按次数决定返回坏包还是好包（12.2「模拟失败可恢复」） */
		installFailures: {},
		/** false 时 crc-corrupt 每次都返回坏包（测试精确控制用） */
		retryHeals: true,
		...overrides,
	}
}

const jsonHeaders = { 'content-type': 'application/json' }
const zipContentType = 'application/zip'

const ok = body => ({ status: 200, contentType: jsonHeaders['content-type'], text: JSON.stringify(body) })
// 失败响应对应真实 HTTP 状态（401/403/404/500），body 内 code 与状态一致（契约第 6 节）
const fail = (status, code, msg) => ({ status, contentType: jsonHeaders['content-type'], text: JSON.stringify({ code, msg, success: false }) })
const notFound = () => fail(404, 404, '资源不存在或无权可见')
const forbidden = () => fail(403, 403, '账号缺少对应权限，请在平台调整角色权限')

/**
 * 内存构造 store 模式 zip（只服务桩下载；解析器侧支持 store 与 deflate）。
 * 支持 entry.uncompressedSize 伪造声明大小（超限用例不需要真造 100MB 数据），
 * entry.corrupt = true 时翻转 payload 首字节使解压 CRC 与声明不符。
 * @param {Array<{ name: string, data: string|Buffer, uncompressedSize?: number, corrupt?: boolean }>} entries
 */
function makeStubZip(entries) {
	const chunks = []
	const centralChunks = []
	let offset = 0
	for (const entry of entries) {
		const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
		const payload = Buffer.from(raw)
		if (entry.corrupt) payload[0] = payload[0] ^ 0xff
		const name = Buffer.from(entry.name, 'utf8')
		const crc = archive.crc32(raw)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(0, 6)
		local.writeUInt16LE(0, 8) // store
		local.writeUInt32LE(crc >>> 0, 14)
		local.writeUInt32LE(payload.length, 18)
		local.writeUInt32LE(entry.uncompressedSize ?? raw.length, 22)
		local.writeUInt16LE(name.length, 26)
		chunks.push(local, name, payload)

		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(0, 8)
		central.writeUInt16LE(0, 10)
		central.writeUInt32LE(crc >>> 0, 16)
		central.writeUInt32LE(payload.length, 20)
		central.writeUInt32LE(entry.uncompressedSize ?? raw.length, 24)
		central.writeUInt16LE(name.length, 28)
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
		central.writeUInt32LE(offset, 42)
		centralChunks.push(central, name)

		offset += local.length + name.length + payload.length
	}
	const centralBuffer = Buffer.concat(centralChunks)
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0)
	eocd.writeUInt16LE(entries.length, 8)
	eocd.writeUInt16LE(entries.length, 10)
	eocd.writeUInt32LE(centralBuffer.length, 12)
	eocd.writeUInt32LE(offset, 16)
	return Buffer.concat([...chunks, centralBuffer, eocd])
}

/**
 * 按 stubInstallCase 构造桩技能包（7.2 四种桩包 + 正常包）。
 * @param {StubSkill} skill
 * @param {ReturnType<typeof createStubState>} state
 * @param {string} version 包内文件携带版本号，供升级用例断言内容变化
 * @returns {Buffer}
 */
function buildStubPackage(skill, state, version = '') {
	const overview = `---\nname: ${skill.slug}\ndescription: ${skill.displayName}。\n---\n\n${skill.overview.replace(/^---\n[\s\S]*?---\n\n/, '')}`
	switch (skill.stubInstallCase) {
		case 'crc-corrupt': {
			const healed = !state.retryHeals || (state.installFailures[skill.slug] || 0) >= 1
			const entries = [
				{ name: `${skill.slug}/SKILL.md`, data: overview },
				{ name: `${skill.slug}/reference.txt`, data: `api-mocker 桩包参考文件 v${version}` },
			]
			return healed ? makeStubZip(entries) : makeStubZip(entries.map(entry => ({ ...entry, corrupt: true })))
		}
		case 'source-verify':
			// SKILL.md 身份与目录项不一致（slug/displayName 都对不上）
			return makeStubZip([{ name: `${skill.slug}/SKILL.md`, data: '---\nname: unrelated-name\ndescription: 与目录项不符的元数据。\n---\n\n内容本身合法。\n' }])
		case 'missing-skillmd':
			return makeStubZip([{ name: `${skill.slug}/README.txt`, data: '只有说明文件，没有 SKILL.md。' }])
		case 'oversize':
			// 声明解压大小超过单文件 10MB 限额，实际 payload 极小（解析器按声明值检查）
			return makeStubZip([
				{ name: `${skill.slug}/SKILL.md`, data: overview },
				{ name: `${skill.slug}/blob.bin`, data: 'declared-too-big', uncompressedSize: 11 * 1024 * 1024 },
			])
		default:
			return makeStubZip([
				{ name: `${skill.slug}/SKILL.md`, data: overview },
				{ name: `${skill.slug}/reference.txt`, data: `${skill.displayName} 桩包参考文件 v${version}` },
			])
	}
}

/** @param {string} text */
function matchQuery(text, q) {
	const needle = (q || '').trim().toLowerCase()
	if (!needle) return true
	return ['displayName', 'summary', 'skillLabel'].some(key => String(text[key] || '').toLowerCase().includes(needle))
}

/**
 * 构造与真实 HTTP 传输同形的桩 transport。
 * @param {ReturnType<typeof createStubState>} state
 */
function createTransport(state) {
	/**
	 * @param {{ path: string, query?: Record<string, string>, method?: string, body?: any }} request
	 */
	return async function stubRequest(request) {
		const { path, query = {}, method = 'GET', body = null } = request
		if (state.unauthorized) return fail(401, 401, 'token 失效，请重新登录')

		if (path === '/login') {
			if (state.captchaRequired && !(query.code && query.uuid)) return ok({ code: 418, msg: '需要验证码', success: false, captcha: true })
			const { username, password } = body || {}
			if (username !== STUB_ACCOUNT.username || password !== STUB_ACCOUNT.password) return ok({ code: 500, msg: '用户名或密码错误', success: false })
			state.loggedIn = true
			state.username = username
			return ok({ code: 200, msg: '登录成功', token: 'stub-jwt-token', success: true })
		}
		if (path === '/captchaImage') return ok({ code: 200, msg: '操作成功', success: true, uuid: 'stub-uuid', image: 'data:image/svg+xml;base64,c3R1Yg==' })
		if (path === '/logout') {
			state.loggedIn = false
			return ok({ code: 200, msg: '操作成功', success: true })
		}

		if (!state.loggedIn) return fail(401, 401, '未登录或登录已过期')

		if (path === '/search') {
			if (state.catalogFailure) return { status: 500, contentType: jsonHeaders['content-type'], text: JSON.stringify({ code: 500, msg: '服务内部错误', success: false }) }
			const page = Math.max(0, Number(query.page) || 0)
			const size = Math.max(1, Number(query.size) || 20)
			let items = STUB_SKILLS.filter(skill => skill.slug !== 'secret-skill').map(searchItem)
			if (query.label) items = items.filter(item => item.skillLabel === query.label)
			items = items.filter(item => matchQuery(item, query.q))
			const sort = query.sort || 'newest'
			const sorters = {
				newest: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
				downloads: (a, b) => b.downloadCount - a.downloadCount,
				rating: (a, b) => b.ratingAvg - a.ratingAvg,
				relevance: (a, b) => b.starCount - a.starCount,
			}
			items.sort(sorters[sort] || sorters.newest)
			const slice = items.slice(page * size, (page + 1) * size)
			const labelCounts = new Map()
			for (const skill of STUB_SKILLS) {
				if (skill.slug === 'secret-skill') continue
				labelCounts.set(skill.skillLabel, (labelCounts.get(skill.skillLabel) || 0) + 1)
			}
			return ok({
				code: 200,
				msg: '搜索成功',
				success: true,
				items: slice,
				total: items.length,
				page,
				size,
				labelStats: [...labelCounts.entries()].map(([label, count]) => ({ label, count })),
				has_next: (page + 1) * size < items.length,
			})
		}

		const detailMatch = /^\/([^/]+)\/([^/]+)$/.exec(path)
		if (detailMatch) {
			const [ns, slug] = [decodeURIComponent(detailMatch[1]), decodeURIComponent(detailMatch[2])]
			const skill = STUB_SKILLS.find(item => item.slug === slug && ns === 'global')
			if (!skill) return notFound()
			if (skill.slug === 'secret-skill') return forbidden()
			return ok({ code: 200, msg: 'response.success.read', success: true, ...detailBody(skill) })
		}

		const versionsMatch = /^\/([^/]+)\/([^/]+)\/versions$/.exec(path)
		if (versionsMatch) {
			const skill = STUB_SKILLS.find(item => item.slug === decodeURIComponent(versionsMatch[2]))
			if (!skill) return notFound()
			if (skill.slug === 'secret-skill') return forbidden()
			const items = [...skill.versions].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
			return ok({ code: 200, success: true, items, total: items.length, page: Number(query.page) || 0, size: Number(query.size) || 20 })
		}

		const fileMatch = /^\/([^/]+)\/([^/]+)\/versions\/([^/]+)\/file$/.exec(path)
		if (fileMatch) {
			const skill = STUB_SKILLS.find(item => item.slug === decodeURIComponent(fileMatch[2]))
			const version = decodeURIComponent(fileMatch[3])
			if (!skill) return notFound()
			if (skill.slug === 'secret-skill') return forbidden()
			const entry = skill.versions.find(item => item.version === version)
			if (!entry || entry.status !== 'PUBLISHED') return notFound()
			return { status: 200, contentType: 'application/octet-stream', text: skill.overview }
		}

		// 安装下载（8.1 步骤 3）：固定版本 ZIP 流；Content-Type 分流由适配层处理
		const downloadMatch = /^\/([^/]+)\/([^/]+)\/versions\/([^/]+)\/download$/.exec(path)
		if (downloadMatch) {
			const skill = STUB_SKILLS.find(item => item.slug === decodeURIComponent(downloadMatch[2]))
			const version = decodeURIComponent(downloadMatch[3])
			if (!skill) return notFound()
			if (skill.slug === 'secret-skill') return forbidden()
			const entry = skill.versions.find(item => item.version === version)
			if (!entry) return notFound()
			// 安装门禁同第 7 节：PUBLISHED 且 downloadReady 才可下载（草稿/未就绪 404）
			if (entry.status !== 'PUBLISHED' || entry.downloadReady !== true) return notFound()
			if (typeof request.onProgress === 'function') request.onProgress(entry.totalSize, entry.totalSize)
			const bytes = buildStubPackage(skill, state, version)
			// crc-corrupt：首次下载返回坏包并推进失败计数，重试即好包（12.2「模拟失败可恢复」）；
			// retryHeals=false 时不推进计数，每次都是坏包（测试精确控制用）
			if (skill.stubInstallCase === 'crc-corrupt' && state.retryHeals) state.installFailures[skill.slug] = 1
			return { status: 200, contentType: zipContentType, bytes }
		}

		return notFound()
	}
}

module.exports = {
	STUB_ACCOUNT,
	STUB_SKILLS,
	createStubState,
	createTransport,
}
