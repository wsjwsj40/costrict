/**
 * Skill 市场与本地技能管理的共享模型层（阶段 0）。
 *
 * 本文件只放纯函数与常量：不读磁盘、不碰 vscode API，扩展侧与测试直接 require。
 * 字段口径见 docs/dicode-skill-market.md 第 5 节，错误码见 7.1，状态机见 5.4。
 */

const crypto = require("node:crypto")

/** 登记文件名，位于 <workspace>/.agents/ 下 */
const REGISTRY_FILE = "skills.registry.json"
/** 技能目录相对工作区的片段 */
const SKILLS_DIR_SEGMENTS = [".agents", "skills"]
/** 本地导入项的固定版本号：本地来源没有版本概念 */
const LOCAL_VERSION = "0.0.0-local"
/** 安装目录名单层长度上限（5.5） */
const DIR_NAME_MAX_LENGTH = 64

/**
 * 技能来源。market 为市场安装，import 为本地导入（两者都写登记），
 * external 为手工放进 .agents/skills/ 的技能（不写登记，由索引侧识别）。
 * @readonly
 * @enum {string}
 */
const SOURCES = Object.freeze({ MARKET: "market", IMPORT: "import", EXTERNAL: "external" })

/**
 * 目录项兼容状态（5.1）。接口无对应字段，默认 compatible。
 * @readonly
 * @enum {string}
 */
const COMPAT_STATES = Object.freeze({ COMPATIBLE: "compatible", INCOMPATIBLE: "incompatible", RESTRICTED: "restricted" })

/**
 * 安装任务态（5.3）。installing 的细分阶段按顺序推进，UI 统一显示【安装中…】。
 * @readonly
 * @enum {string}
 */
const JOB_STATES = Object.freeze({
	QUEUED: "queued",
	DOWNLOADING: "downloading",
	VERIFYING: "verifying",
	EXTRACTING: "extracting",
	REGISTERING: "registering",
	DONE: "done",
	FAILED: "failed",
})

/** 安装管道阶段（顺序即推进顺序，queued 不在其中） */
const JOB_PIPELINE = Object.freeze([JOB_STATES.DOWNLOADING, JOB_STATES.VERIFYING, JOB_STATES.EXTRACTING, JOB_STATES.REGISTERING])

/** 终态：不再接受后续事件（5.3 事件幂等） */
const TERMINAL_JOB_STATES = Object.freeze([JOB_STATES.DONE, JOB_STATES.FAILED])

/**
 * UI 五态（5.4）。blocked 不是持久化状态，是 failed && !retryable 的推导态。
 * @readonly
 * @enum {string}
 */
const SKILL_STATES = Object.freeze({
	READY: "ready",
	INSTALLING: "installing",
	INSTALLED: "installed",
	FAILED: "failed",
	BLOCKED: "blocked",
})

/**
 * 错误码表（7.1）。retryable 决定 UI 给【重试】还是【无法安装】，
 * 未知码一律按不可重试处理，避免把不可恢复的失败暴露成重试按钮。
 * requiresLogin 仅用于 401：不是普通重试，而是清 token 重新登录后原请求重试一次。
 */
const ERROR_CODES = Object.freeze({
	NETWORK: { retryable: true, message: "网络异常，请检查连接后重试" },
	UNAUTHORIZED: { retryable: true, requiresLogin: true, message: "登录已失效，请重新登录后重试" },
	FORBIDDEN: { retryable: false, message: "当前账号没有该技能的权限，请联系管理员调整角色" },
	NOT_FOUND: { retryable: false, message: "技能或版本不存在，已刷新列表" },
	INCOMPATIBLE_CLIENT: { retryable: false, message: "该技能需要更高版本的插件" },
	ORG_RESTRICTED: { retryable: false, message: "组织策略已限制该技能" },
	SOURCE_VERIFY_FAILED: { retryable: false, message: "技能来源校验未通过" },
	ARCHIVE_INVALID: { retryable: false, message: "技能包结构不合法" },
	ARCHIVE_TOO_LARGE: { retryable: false, message: "技能包超出大小限制" },
	ARCHIVE_CORRUPT: { retryable: true, message: "技能包校验失败，请重新下载" },
	DISK_FULL: { retryable: true, message: "磁盘空间不足，清理后可重试" },
	VERSION_CONFLICT: { retryable: true, message: "登记内容发生并发冲突，请重试" },
	LOCK_TIMEOUT: { retryable: true, message: "目标目录被其他任务占用，请稍后重试" },
	DIR_CONFLICT: { retryable: false, message: "目标目录已被其他技能占用" },
	INTERRUPTED: { retryable: true, message: "任务因插件重启中断，可重新安装" },
})

/** 全部错误码名称，供测试与 UI 校验完整性 */
const ERROR_CODE_NAMES = Object.freeze(Object.keys(ERROR_CODES))

/**
 * 市场目录项（5.1）。由 skillMarket.js 适配层从服务端字段映射而来。
 * @typedef {Object} MarketSkill
 * @property {string} id            稳定标识 `${namespace}/${slug}`，安装以 id + version 定位
 * @property {string} namespace     主命名空间 slug，作路径参数时需 URL-encode
 * @property {string} slug          技能 slug
 * @property {string} name          展示名（← displayName）
 * @property {string} publisher     发布者（← createdByName）
 * @property {string} [version]     列表接口不返回，来自详情 publishedVersion，空态兜底
 * @property {string} summary       一句话简介，参与搜索
 * @property {string[]} tags        标签，参与搜索
 * @property {string} [icon]        base64 data URL
 * @property {boolean} [needApiKey] 运行是否需要 API Key
 * @property {'compatible'|'incompatible'|'restricted'} compat 无服务端字段，默认 compatible
 * @property {string} [minClientVersion] incompatible 时的最低客户端版本
 * @property {string} [compatReason]     restricted 时的说明
 * @property {number} [updatedAt]   毫秒时间戳
 */

/**
 * 安装登记项（5.2）。存于 <workspace>/.agents/skills.registry.json。
 * @typedef {Object} InstallRecord
 * @property {string} skillId       market 取目录项 id；本地导入取 SKILL.md 的 name
 * @property {string} name          展示名，取自 SKILL.md
 * @property {string} version       market 取目录项版本；本地导入为 '0.0.0-local'
 * @property {string|null} digest   market：客户端下载后自算的 zip sha256；本地导入为 null
 * @property {string} dirDigest     安装完成时目录内容的 sha256，用于检测外部改动
 * @property {string} dir           相对工作区的安装目录（.agents/skills/<来源目录名>）
 * @property {'market'|'import'} source
 * @property {string} origin        市场包内根目录名 / 导入源文件夹名
 * @property {number} installedAt   毫秒时间戳
 * @property {string} [publisher]   市场安装时随目录项落库，供离线渲染
 * @property {string} [summary]     同上
 * @property {string[]} [tags]      同上
 * @property {boolean} [indexStale] 登记成功但 Agent 索引未刷新
 * @property {boolean} [altered]    dirDigest 不一致的缓存标记，只作附注不改状态
 */

/**
 * 安装任务（5.3）。持久化在 <globalStorageUri>/skill-jobs/<workspaceId>.json。
 * @typedef {Object} InstallJob
 * @property {string} jobId
 * @property {string} workspaceId   工作区路径的短散列，事件、去重、任务日志与锁路径统一用它
 * @property {string} skillId
 * @property {string} version
 * @property {string} [digest]      下载完成后自算的 zip sha256；downloading 阶段缺省
 * @property {'queued'|'downloading'|'verifying'|'extracting'|'registering'|'done'|'failed'} state
 * @property {number} seq           本任务事件序号，从 0 单调递增
 * @property {number} [progress]    0-100，下载阶段有效
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {boolean} retryable
 * @property {number} startedAt     毫秒时间戳
 * @property {number} [finishedAt]  毫秒时间戳
 */

/**
 * 安装事件。按 jobId + seq 幂等，且只接受 seq 严格递增（8.3）。
 * @typedef {Object} InstallEvent
 * @property {string} jobId
 * @property {string} workspaceId
 * @property {string} skillId
 * @property {string} version
 * @property {string} [digest]
 * @property {string} state
 * @property {number} seq
 * @property {number} [progress]
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {boolean} retryable
 */

/** Windows 保留名：CON/PRN/AUX/NUL/COM1-9/LPT1-9，大小写不敏感，带扩展名同样保留 */
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 目录名校验失败的原因，供 UI 提示与测试断言 */
const DIR_NAME_ERRORS = Object.freeze({
	EMPTY: "目录名不能为空",
	DOT: "目录名不能是 . 或 ..",
	SEPARATOR: "目录名不能包含路径分隔符",
	CONTROL: "目录名不能包含控制字符",
	HIDDEN: "目录名不能以点开头",
	RESERVED: "目录名不能使用 Windows 保留名",
	TRAILING: "目录名不能以点或空格结尾",
	TOO_LONG: `目录名不能超过 ${DIR_NAME_MAX_LENGTH} 个字符`,
})

/**
 * 校验单层安装目录名（5.5）。不做大小写折叠、不做非法字符替换：
 * 名字不合规就拒绝，由调用方报 ARCHIVE_INVALID，绝不静默改名。
 * @param {unknown} name
 * @returns {{ ok: true, dir: string } | { ok: false, kind: string, message: string }}
 */
function validateDirName(name) {
	/** @param {string} kind */
	const fail = kind => ({ ok: false, kind, message: DIR_NAME_ERRORS[kind] })
	if (typeof name !== "string" || name.length === 0) return fail("EMPTY")
	if (name === "." || name === "..") return fail("DOT")
	if (name.includes("/") || name.includes("\\")) return fail("SEPARATOR")
	if (/[\u0000-\u001f\u007f]/.test(name)) return fail("CONTROL")
	if (name.startsWith(".")) return fail("HIDDEN")
	if (WINDOWS_RESERVED_NAME.test(name.split(".")[0].trimEnd())) return fail("RESERVED")
	if (/[. ]$/.test(name)) return fail("TRAILING")
	// 长度按 UTF-16 长度计，对 BMP 内字符（含中文）即字符数
	if (name.length > DIR_NAME_MAX_LENGTH) return fail("TOO_LONG")
	return { ok: true, dir: name }
}

/**
 * 取合法的目录名，不合法则抛错（code = ARCHIVE_INVALID）。
 * @param {unknown} name
 * @returns {string}
 */
function normalizeDirName(name) {
	const result = validateDirName(name)
	if (!result.ok) {
		const error = new Error(result.message)
		error.code = "ARCHIVE_INVALID"
		error.kind = result.kind
		throw error
	}
	return result.dir
}

/**
 * 拆版本号：去掉前导 v 与 build 元数据（+xxx），core 段取数字前缀，其余进预发布段。
 * @param {string|number} value
 * @returns {{ core: number[], pre: string[] }}
 */
function splitVersion(value) {
	const text = String(value ?? "").trim().replace(/^v/i, "")
	const withoutBuild = text.split("+")[0]
	const dash = withoutBuild.indexOf("-")
	const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
	const preText = dash === -1 ? "" : withoutBuild.slice(dash + 1)
	const core = coreText.split(".").map(segment => {
		const match = /^\d+/.exec(segment)
		return match ? Number(match[0]) : 0
	})
	return { core, pre: preText ? preText.split(".") : [] }
}

/**
 * 比较两个版本号，返回 1（a 新）/ 0（相同）/ -1（b 新）。
 * 支持 1.10.0 > 1.9.0、1.0 == 1.0.0、预发布低于同版本正式版（1.0.0-beta.2 < 1.0.0）；
 * 预发布段按 semver 规则：纯数字段低于非数字段，段数少的更小（1.0.0-alpha < 1.0.0-alpha.1）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersion(a, b) {
	const left = splitVersion(a)
	const right = splitVersion(b)
	const coreLength = Math.max(left.core.length, right.core.length)
	for (let i = 0; i < coreLength; i++) {
		const diff = (left.core[i] || 0) - (right.core[i] || 0)
		if (diff !== 0) return diff > 0 ? 1 : -1
	}
	if (left.pre.length === 0 && right.pre.length === 0) return 0
	if (left.pre.length === 0) return 1
	if (right.pre.length === 0) return -1
	const preLength = Math.max(left.pre.length, right.pre.length)
	for (let i = 0; i < preLength; i++) {
		const l = left.pre[i]
		const r = right.pre[i]
		if (l === undefined) return -1
		if (r === undefined) return 1
		const lNumeric = /^\d+$/.test(l)
		const rNumeric = /^\d+$/.test(r)
		if (lNumeric && rNumeric) {
			const diff = Number(l) - Number(r)
			if (diff !== 0) return diff > 0 ? 1 : -1
			continue
		}
		if (lNumeric !== rNumeric) return lNumeric ? -1 : 1
		if (l !== r) return l > r ? 1 : -1
	}
	return 0
}

/**
 * 安装去重键：(workspaceId, skillId, version) 三段拼成内存键，
 * 用 NUL 分隔避免 skillId 里的 / : 等字符造成碰撞。只在内存与任务表内使用，不落登记。
 * @param {string} workspaceId
 * @param {string} skillId
 * @param {string} version
 * @returns {string}
 */
function dedupeKey(workspaceId, skillId, version) {
	return [workspaceId, skillId, version].join("\u0000")
}

/**
 * 工作区标识：路径的短散列（sha256 前 12 位十六进制）。
 * 事件、去重、任务日志与锁路径统一用它。Windows 盘符路径统一分隔符后小写，
 * 保证 D:\proj 与 d:/proj 得到同一个 ID；类 Unix 路径保留大小写（区分大小写文件系统）。
 * @param {string} workspacePath
 * @returns {string}
 */
function workspaceIdFor(workspacePath) {
	let normalized = String(workspacePath || "").replace(/\\/g, "/").replace(/\/+$/, "")
	if (/^[a-zA-Z]:(\/|$)/.test(normalized)) normalized = normalized.toLowerCase()
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12)
}

/** 状态 → 按钮文案（5.4 表格的唯一口径） */
const BUTTONS = Object.freeze({
	INSTALL: "安装",
	INSTALLING: "安装中…",
	INSTALLED: "已安装",
	RETRY: "重试",
	INCOMPATIBLE: "不兼容",
	RESTRICTED: "已限制",
	BLOCKED: "无法安装",
})

/** 安装中细分阶段的文案，UI 统一显示【安装中…】 */
const JOB_STATE_LABELS = Object.freeze({
	queued: "排队中",
	downloading: "下载中",
	verifying: "校验中",
	extracting: "解压中",
	registering: "写入登记",
})

/**
 * 已安装判定（5.4）：登记存在、来源为 market。digest 不参与判定——
 * 包摘要永远不等于目录摘要，用它判定会让「已安装」永不成立。
 * @param {InstallRecord|null|undefined} record
 * @param {boolean} skillMdExists 登记的 dir 下 SKILL.md 是否存在
 * @returns {boolean}
 */
function isInstalled(record, skillMdExists) {
	return Boolean(record && record.source === SOURCES.MARKET && skillMdExists)
}

/**
 * 推导一个技能的 UI 状态与按钮（5.4）。优先级：在跑任务 > 失败任务 > 已安装 > 目录级兼容 > 可安装。
 * blocked 不是持久化状态，是 failed && !retryable 的推导态；目录级不兼容/已限制虽然同为「不可点」，
 * 按钮文案不复用【无法安装】，避免把策略限制说成包错误。
 * @param {Object} [options]
 * @param {MarketSkill|null} [options.catalog] 市场目录项；本地技能管理页无此值
 * @param {InstallRecord|null} [options.record] 登记项
 * @param {InstallJob|null} [options.job] 该技能最近一次安装任务
 * @param {boolean} [options.skillMdExists] 登记目录下 SKILL.md 是否存在
 * @param {boolean} [options.dirTaken] 目标目录已被本地同名技能占用
 * @returns {{ state: string, button: string, enabled: boolean, note: string, errorCode?: string, version?: string, jobId?: string }}
 */
function deriveState(options = {}) {
	const { catalog = null, record = null, job = null, skillMdExists = false, dirTaken = false } = options
	if (job && !TERMINAL_JOB_STATES.includes(job.state)) {
		const label = JOB_STATE_LABELS[job.state] || "安装中"
		const progress = typeof job.progress === "number" ? ` ${Math.round(job.progress)}%` : ""
		return { state: SKILL_STATES.INSTALLING, button: BUTTONS.INSTALLING, enabled: false, note: `${label}${progress}`, jobId: job.jobId }
	}
	if (job && job.state === JOB_STATES.FAILED) {
		const reason = job.errorMessage || errorInfo(job.errorCode).message
		if (job.retryable === true)
			return { state: SKILL_STATES.FAILED, button: BUTTONS.RETRY, enabled: true, note: reason, errorCode: job.errorCode, jobId: job.jobId }
		return { state: SKILL_STATES.BLOCKED, button: BUTTONS.BLOCKED, enabled: false, note: reason, errorCode: job.errorCode, jobId: job.jobId }
	}
	if (isInstalled(record, skillMdExists)) {
		const notes = []
		if (record.altered) notes.push("目录内容已变化")
		if (catalog?.version && compareVersion(catalog.version, record.version) > 0) notes.push(`有 v${catalog.version} 可用`)
		return { state: SKILL_STATES.INSTALLED, button: BUTTONS.INSTALLED, enabled: false, note: notes.join("；"), version: record.version }
	}
	if (catalog && catalog.compat === COMPAT_STATES.INCOMPATIBLE)
		return {
			state: SKILL_STATES.BLOCKED,
			button: BUTTONS.INCOMPATIBLE,
			enabled: false,
			note: catalog.minClientVersion ? `需要插件 v${catalog.minClientVersion} 及以上` : "当前客户端版本过低",
		}
	if (catalog && catalog.compat === COMPAT_STATES.RESTRICTED)
		return { state: SKILL_STATES.BLOCKED, button: BUTTONS.RESTRICTED, enabled: false, note: catalog.compatReason || "组织策略已限制该技能" }
	const notes = []
	if (dirTaken) notes.push("本地已有同名技能")
	if (record && record.source === SOURCES.MARKET && !skillMdExists) notes.push("登记存在但目录缺失，可重新安装")
	return { state: SKILL_STATES.READY, button: BUTTONS.INSTALL, enabled: true, note: notes.join("；") }
}

/**
 * 查错误码定义，未知码按不可重试处理。
 * @param {string} [errorCode]
 * @returns {{ retryable: boolean, requiresLogin?: boolean, message: string }}
 */
function errorInfo(errorCode) {
	return ERROR_CODES[errorCode] || { retryable: false, message: "未知错误" }
}

/**
 * @param {string} [errorCode]
 * @returns {boolean} 该错误是否允许用户重试
 */
function isRetryable(errorCode) {
	return errorInfo(errorCode).retryable === true
}

module.exports = {
	REGISTRY_FILE,
	SKILLS_DIR_SEGMENTS,
	LOCAL_VERSION,
	DIR_NAME_MAX_LENGTH,
	SOURCES,
	COMPAT_STATES,
	JOB_STATES,
	JOB_PIPELINE,
	TERMINAL_JOB_STATES,
	SKILL_STATES,
	ERROR_CODES,
	ERROR_CODE_NAMES,
	DIR_NAME_ERRORS,
	validateDirName,
	normalizeDirName,
	splitVersion,
	compareVersion,
	dedupeKey,
	workspaceIdFor,
	BUTTONS,
	JOB_STATE_LABELS,
	isInstalled,
	deriveState,
	errorInfo,
	isRetryable,
}
