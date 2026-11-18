/**
 * 安装登记读写（阶段 0）。
 *
 * 登记是【已安装】页签的主数据源，口径见 docs/dicode-skill-market.md 5.2：
 * 存 <workspace>/.agents/skills.registry.json；先写 .tmp 再 rename；多窗口用 .lock 短锁；
 * 解析失败视为空登记并把损坏文件留为 .bak，不阻塞页面。
 *
 * 这里只做读写与加锁，不判断业务状态；状态推导在 skillsModel.deriveState。
 */

const fs = require("node:fs")
const path = require("node:path")
const { REGISTRY_FILE, SKILLS_DIR_SEGMENTS, SOURCES, normalizeDirName } = require("./skillsModel")

/** 登记文件结构版本，便于后续演进 */
const REGISTRY_VERSION = 1
/** 短锁过期阈值：登记写入是毫秒级操作，超过 5 秒必然是该进程已死 */
const LOCK_STALE_MS = 5000
/** 抢锁等待上限，超时按 7.1 报 LOCK_TIMEOUT（可重试） */
const LOCK_TIMEOUT_MS = 3000
/** 抢锁重试间隔 */
const LOCK_RETRY_MS = 20
/** gitignore 里算作已忽略登记文件的写法 */
const IGNORE_PATTERNS = [".agents", ".agents/**", ".agents/*", ".agents/skills.registry.json", "**/.agents", "*"]

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 登记相关路径。
 * @param {string} workspace 工作区绝对路径
 */
function registryPaths(workspace) {
	const dir = path.join(workspace, ...SKILLS_DIR_SEGMENTS.slice(0, 1))
	const file = path.join(dir, REGISTRY_FILE)
	return { dir, file, tmp: `${file}.tmp`, lock: `${file}.lock`, backup: `${file}.bak` }
}

/**
 * 校验并规范一条登记项：来源只能是 market/import，dir 必须是 .agents/skills/<单层名>。
 * @param {import("./skillsModel").InstallRecord} record
 * @returns {import("./skillsModel").InstallRecord}
 */
function normalizeRecord(record) {
	if (!record || typeof record !== "object") throw new Error("登记项必须是对象")
	if (!record.skillId || typeof record.skillId !== "string") throw new Error("登记项缺少 skillId")
	if (record.source !== SOURCES.MARKET && record.source !== SOURCES.IMPORT) throw new Error(`登记项来源不合法：${record.source}`)
	const relative = String(record.dir || "").replace(/\\/g, "/")
	const prefix = `${SKILLS_DIR_SEGMENTS.join("/")}/`
	if (!relative.startsWith(prefix)) throw new Error(`登记项目录必须是 ${prefix}<目录名>：${record.dir}`)
	const name = normalizeDirName(relative.slice(prefix.length))
	return { ...record, dir: `${prefix}${name}` }
}

/** 只接受结构完整的登记项，残缺项忽略而不是让整页渲染失败 */
function isRecordLike(record) {
	return Boolean(record && typeof record === "object" && typeof record.skillId === "string" && typeof record.dir === "string"
		&& (record.source === SOURCES.MARKET || record.source === SOURCES.IMPORT))
}

/**
 * 读登记。文件不存在或损坏都返回空列表；损坏时把原文件留为 .bak。
 * 原子写保证了这里读到的一定是完整文件，不需要加锁。
 * @param {string} workspace
 * @returns {Promise<{ skills: import("./skillsModel").InstallRecord[], recovered: boolean }>}
 */
async function readRegistry(workspace) {
	const { file, backup } = registryPaths(workspace)
	let text
	try {
		text = await fs.promises.readFile(file, "utf8")
	} catch (error) {
		if (error.code === "ENOENT") return { skills: [], recovered: false }
		throw error
	}
	try {
		const parsed = JSON.parse(text)
		const skills = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.skills) ? parsed.skills : []
		return { skills: skills.filter(isRecordLike), recovered: false }
	} catch {
		// 损坏文件不留在原位（否则每次启动都报错），改名 .bak 保留现场供排查
		await fs.promises.rename(file, backup).catch(() => {})
		return { skills: [], recovered: true }
	}
}

/**
 * 原子写：先写 .tmp 再 rename。Windows 上 rename 可能被杀软短暂占用，留一次重试。
 * @param {string} workspace
 * @param {import("./skillsModel").InstallRecord[]} skills
 */
async function writeRegistryAtomic(workspace, skills) {
	const { dir, file, tmp } = registryPaths(workspace)
	await fs.promises.mkdir(dir, { recursive: true })
	await fs.promises.writeFile(tmp, `${JSON.stringify({ version: REGISTRY_VERSION, skills }, null, 2)}\n`, "utf8")
	try {
		await fs.promises.rename(tmp, file)
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EBUSY") throw error
		await delay(100)
		await fs.promises.rename(tmp, file)
	}
}

/**
 * 在 .registry.json.lock 短锁保护下执行 fn（读-改-写必须整体串行）。
 * 锁失效只看锁文件的 mtime 是否超过 LOCK_STALE_MS，不按「存在时长」猜；
 * 未失效的锁不抢占，等待超过 LOCK_TIMEOUT_MS 报 LOCK_TIMEOUT。
 * @template T
 * @param {string} workspace
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
async function withLock(workspace, fn, options = {}) {
	const { dir, lock } = registryPaths(workspace)
	const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
	const staleMs = options.staleMs ?? LOCK_STALE_MS
	await fs.promises.mkdir(dir, { recursive: true })
	const startedAt = Date.now()
	/** @type {import("node:fs/promises").FileHandle|null} */
	let handle = null
	while (!handle) {
		try {
			handle = await fs.promises.open(lock, "wx")
		} catch (error) {
			if (error.code !== "EEXIST") throw error
			let stale = false
			try {
				stale = Date.now() - (await fs.promises.stat(lock)).mtimeMs > staleMs
			} catch (statError) {
				if (statError.code === "ENOENT") continue
				throw statError
			}
			if (stale) {
				await fs.promises.rm(lock, { force: true })
				continue
			}
			if (Date.now() - startedAt > timeoutMs) {
				const timeout = new Error(`等待登记锁超时（${timeoutMs}ms）`)
				timeout.code = "LOCK_TIMEOUT"
				throw timeout
			}
			await delay(LOCK_RETRY_MS)
		}
	}
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
		return await fn()
	} finally {
		await handle.close().catch(() => {})
		await fs.promises.rm(lock, { force: true }).catch(() => {})
	}
}

/**
 * 加锁读-改-写。mutate 返回 undefined 表示无需写盘（例如删除时没命中）。
 * @param {string} workspace
 * @param {(skills: import("./skillsModel").InstallRecord[]) => Promise<import("./skillsModel").InstallRecord[]|undefined>|import("./skillsModel").InstallRecord[]|undefined} mutate
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<import("./skillsModel").InstallRecord[]>}
 */
async function updateRegistry(workspace, mutate, options) {
	return withLock(workspace, async () => {
		const { skills } = await readRegistry(workspace)
		const next = await mutate(skills.slice())
		if (!next) return skills
		await writeRegistryAtomic(workspace, next)
		return next
	}, options)
}

/**
 * 全量替换登记（加锁）。
 * @param {string} workspace
 * @param {import("./skillsModel").InstallRecord[]} skills
 */
async function writeRegistry(workspace, skills) {
	const normalized = skills.map(normalizeRecord)
	return updateRegistry(workspace, () => normalized)
}

/**
 * 新增或更新一条登记。同一 skillId 视为同一条；否则同一 dir 视为覆盖同一条。
 * @param {string} workspace
 * @param {import("./skillsModel").InstallRecord} record
 * @returns {Promise<import("./skillsModel").InstallRecord[]>}
 */
async function upsertRecord(workspace, record) {
	const normalized = normalizeRecord(record)
	return updateRegistry(workspace, skills => {
		const bySkill = skills.findIndex(item => item.skillId === normalized.skillId)
		const byDir = skills.findIndex(item => item.dir === normalized.dir)
		const index = bySkill >= 0 ? bySkill : byDir
		if (index >= 0) {
			skills[index] = { ...skills[index], ...normalized }
			return skills
		}
		skills.push(normalized)
		return skills
	})
}

/**
 * 删除一条登记。只动登记不动磁盘文件；source 可选，用于只删某一来源的记录。
 * @param {string} workspace
 * @param {{ skillId: string, source?: 'market'|'import' }} target
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<boolean>} 是否真的删掉了记录
 */
async function removeRecord(workspace, target, options) {
	let removed = false
	await updateRegistry(workspace, skills => {
		const next = skills.filter(item => !(item.skillId === target.skillId && (!target.source || item.source === target.source)))
		if (next.length === skills.length) return undefined
		removed = true
		return next
	}, options)
	return removed
}

/**
 * 判断工作区 .gitignore 是否已经忽略登记文件（5.2：不静默修改用户的 .gitignore）。
 * @param {string} workspace
 * @returns {Promise<boolean>}
 */
async function isRegistryIgnored(workspace) {
	let text
	try {
		text = await fs.promises.readFile(path.join(workspace, ".gitignore"), "utf8")
	} catch (error) {
		if (error.code === "ENOENT") return false
		throw error
	}
	return text.split(/\r?\n/).some(line => {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false
		const pattern = trimmed.replace(/^\/+/, "").replace(/\/+$/, "")
		return IGNORE_PATTERNS.includes(pattern)
	})
}

/**
 * 把登记文件写进工作区根 .gitignore（调用方必须先拿到用户确认）。
 * @param {string} workspace
 * @returns {Promise<boolean>} 是否写入（已忽略则返回 false）
 */
async function appendRegistryIgnore(workspace) {
	if (await isRegistryIgnored(workspace)) return false
	const file = path.join(workspace, ".gitignore")
	let existing = ""
	try {
		existing = await fs.promises.readFile(file, "utf8")
	} catch (error) {
		if (error.code !== "ENOENT") throw error
	}
	const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
	await fs.promises.appendFile(file, `${prefix}# DiCode 技能安装登记（机器生成，不入库）\n.agents/${REGISTRY_FILE}\n`, "utf8")
	return true
}

module.exports = {
	REGISTRY_VERSION,
	LOCK_STALE_MS,
	LOCK_TIMEOUT_MS,
	registryPaths,
	normalizeRecord,
	readRegistry,
	writeRegistry,
	updateRegistry,
	upsertRecord,
	removeRecord,
	isRegistryIgnored,
	appendRegistryIgnore,
	withLock,
}
