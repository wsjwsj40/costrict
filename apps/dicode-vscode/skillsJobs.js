/**
 * 安装任务日志与目录锁（阶段 0）。
 *
 * 口径见 docs/dicode-skill-market.md 5.3 / 8.2 / 8.3：
 * - 任务表写在 <globalStorageUri>/skill-jobs/<workspaceId>.json，原子写，不进工作区、不随仓库同步；
 * - 事件按 jobId + seq 幂等，只接受 seq 严格递增，不能拿 (jobId, state) 做幂等键（进度事件会被吞）；
 * - 扩展启动时把非终态任务收敛为 failed + INTERRUPTED（可重试）；
 * - 目录锁在 <globalStorageUri>/skill-locks/<workspaceId>/<dir>.lock，内容 { owner, pid, heartbeatAt }，
 *   运行期每 5 秒心跳，心跳超过 30 秒未更新视为持有者已死，未失效的锁不抢占。
 *
 * 本模块只管状态与锁，不做下载、解压、登记（阶段 3）。
 */

const fs = require("node:fs")
const path = require("node:path")
const { JOB_STATES, TERMINAL_JOB_STATES } = require("./skillsModel")

/** 任务表目录名 */
const JOBS_DIR = "skill-jobs"
/** 目录锁根目录名 */
const LOCKS_DIR = "skill-locks"
/** 任务表结构版本 */
const JOBS_VERSION = 1
/** 心跳间隔 */
const HEARTBEAT_MS = 5000
/** 心跳超过该时长未更新视为持有者已死 */
const LOCK_STALE_MS = 30000
/** 抢锁等待上限，超时按 7.1 报 LOCK_TIMEOUT（可重试） */
const LOCK_TIMEOUT_MS = 60000
/** 抢锁重试间隔 */
const LOCK_RETRY_MS = 50

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * workspaceId 会拼进文件名，必须挡住路径分隔符与 .. 之类。
 * @param {string} workspaceId
 */
function assertWorkspaceId(workspaceId) {
	if (typeof workspaceId !== "string" || !workspaceId || workspaceId.includes("/") || workspaceId.includes("\\") || workspaceId.includes(".."))
		throw new Error(`workspaceId 不合法：${workspaceId}`)
}

/**
 * 目录锁的目录名同样要挡住路径穿越。
 * @param {string} dir
 */
function assertLockName(dir) {
	if (typeof dir !== "string" || !dir || dir.includes("/") || dir.includes("\\") || dir === "." || dir === "..")
		throw new Error(`锁名称不合法：${dir}`)
}

/** 从事件挑出可落到任务的字段，避免事件里的无关字段污染任务表 */
function jobFieldsFromEvent(event) {
	/** @type {Record<string, unknown>} */
	const fields = { state: event.state, seq: event.seq }
	for (const key of ["progress", "digest", "errorCode", "errorMessage", "retryable"])
		if (event[key] !== undefined) fields[key] = event[key]
	return fields
}

class SkillJobs {
	/**
	 * @param {{ storageDir: string }} options storageDir 取 context.globalStorageUri.fsPath
	 */
	constructor(options) {
		if (!options || !options.storageDir) throw new Error("SkillJobs 需要 storageDir")
		this.storageDir = options.storageDir
		/** @type {Map<string, Promise<void>>} 同工作区的任务表读改写串行链（并发安装的事件不能互相覆盖） */
		this.#writeChains = new Map()
	}

	/** @type {Map<string, Promise<void>>} */
	#writeChains

	/**
	 * 把任务表读改写操作排进同工作区的串行链。
	 * @template T
	 * @param {string} workspaceId
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	#enqueueWrite(workspaceId, fn) {
		const previous = this.#writeChains.get(workspaceId) || Promise.resolve()
		const next = previous.then(fn, fn)
		this.#writeChains.set(workspaceId, next.then(() => undefined, () => undefined))
		return next
	}

	/** @param {string} workspaceId */
	jobsFile(workspaceId) {
		assertWorkspaceId(workspaceId)
		return path.join(this.storageDir, JOBS_DIR, `${workspaceId}.json`)
	}

	/** @param {string} workspaceId */
	locksDir(workspaceId) {
		assertWorkspaceId(workspaceId)
		return path.join(this.storageDir, LOCKS_DIR, workspaceId)
	}

	/** @param {string} workspaceId @param {string} dir */
	lockFile(workspaceId, dir) {
		assertLockName(dir)
		return path.join(this.locksDir(workspaceId), `${dir}.lock`)
	}

	/**
	 * 读任务表。文件缺失或损坏都返回空表；损坏文件留 .bak 保留现场。
	 * @param {string} workspaceId
	 * @returns {Promise<import("./skillsModel").InstallJob[]>}
	 */
	async read(workspaceId) {
		const file = this.jobsFile(workspaceId)
		let text
		try {
			text = await fs.promises.readFile(file, "utf8")
		} catch (error) {
			if (error.code === "ENOENT") return []
			throw error
		}
		try {
			const parsed = JSON.parse(text)
			const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : []
			return jobs.filter(job => job && typeof job.jobId === "string" && typeof job.state === "string")
		} catch {
			await fs.promises.rename(file, `${file}.bak`).catch(() => {})
			return []
		}
	}

	/**
	 * 原子写任务表。
	 * @param {string} workspaceId
	 * @param {import("./skillsModel").InstallJob[]} jobs
	 */
	async write(workspaceId, jobs) {
		const file = this.jobsFile(workspaceId)
		await fs.promises.mkdir(path.dirname(file), { recursive: true })
		const tmp = `${file}.tmp`
		await fs.promises.writeFile(tmp, `${JSON.stringify({ version: JOBS_VERSION, jobs }, null, 2)}\n`, "utf8")
		await fs.promises.rename(tmp, file)
	}

	/**
	 * 扩展启动时调用：把非终态任务收敛为 failed + INTERRUPTED（可重试），seq 不伪造。
	 * @param {string} workspaceId
	 * @param {number} [now]
	 * @returns {Promise<{ jobs: import("./skillsModel").InstallJob[], interrupted: number }>}
	 */
	recover(workspaceId, now = Date.now()) {
		return this.#enqueueWrite(workspaceId, () => this.#recoverLocked(workspaceId, now))
	}

	/** recover 的实际执行体，仅在串行链内调用。 */
	async #recoverLocked(workspaceId, now) {
		const jobs = await this.read(workspaceId)
		let interrupted = 0
		for (const job of jobs) {
			if (TERMINAL_JOB_STATES.includes(job.state)) continue
			Object.assign(job, {
				state: JOB_STATES.FAILED,
				errorCode: "INTERRUPTED",
				errorMessage: "插件重启导致安装中断，可重新安装",
				retryable: true,
				finishedAt: now,
			})
			interrupted++
		}
		if (interrupted > 0) await this.write(workspaceId, jobs)
		return { jobs, interrupted }
	}

	/**
	 * 应用一条安装事件。重复或过期的 seq 直接忽略；已终态的任务不再接受事件。
	 * 读改写经同工作区串行链，避免并发安装的事件互相覆盖任务表。
	 * @param {import("./skillsModel").InstallEvent} event
	 * @returns {Promise<{ job: import("./skillsModel").InstallJob|null, applied: boolean }>}
	 */
	appendEvent(event) {
		return this.#enqueueWrite(event.workspaceId, () => this.#appendEventLocked(event))
	}

	/**
	 * appendEvent 的实际执行体，仅在串行链内调用。
	 * @param {import("./skillsModel").InstallEvent} event
	 */
	async #appendEventLocked(event) {
		if (!event || typeof event.jobId !== "string") throw new Error("安装事件缺少 jobId")
		if (!Number.isInteger(event.seq) || event.seq < 0) throw new Error("安装事件 seq 必须是非负整数")
		const jobs = await this.read(event.workspaceId)
		const job = jobs.find(item => item.jobId === event.jobId)
		if (!job) {
			/** @type {import("./skillsModel").InstallJob} */
			const created = {
				jobId: event.jobId,
				workspaceId: event.workspaceId,
				skillId: event.skillId,
				version: event.version,
				state: event.state,
				seq: event.seq,
				retryable: event.retryable === true,
				startedAt: event.startedAt || Date.now(),
				...jobFieldsFromEvent(event),
			}
			if (TERMINAL_JOB_STATES.includes(created.state) && !created.finishedAt) created.finishedAt = Date.now()
			jobs.push(created)
			await this.write(event.workspaceId, jobs)
			return { job: created, applied: true }
		}
		if (TERMINAL_JOB_STATES.includes(job.state)) return { job, applied: false }
		if (event.seq <= job.seq) return { job, applied: false }
		Object.assign(job, jobFieldsFromEvent(event))
		if (TERMINAL_JOB_STATES.includes(job.state) && !job.finishedAt) job.finishedAt = Date.now()
		await this.write(event.workspaceId, jobs)
		return { job, applied: true }
	}

	/**
	 * 取快照（重开 webview 时先快照后增量）。
	 * @param {string} workspaceId
	 * @returns {Promise<import("./skillsModel").InstallJob[]>}
	 */
	async snapshot(workspaceId) {
		return this.read(workspaceId)
	}

	/**
	 * 抢目录锁。返回 release()，内部定时心跳；heartbeatMs 传 0 可关闭心跳（测试用）。
	 * @param {string} workspaceId
	 * @param {string} dir 目标目录名（单层）
	 * @param {{ owner?: string, timeoutMs?: number, staleMs?: number, heartbeatMs?: number, now?: () => number }} [options]
	 * @returns {Promise<{ release: () => Promise<void>, heartbeat: () => Promise<void> }>}
	 */
	async acquireLock(workspaceId, dir, options = {}) {
		const owner = options.owner || `${process.pid}-${Date.now()}`
		const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
		const staleMs = options.staleMs ?? LOCK_STALE_MS
		const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
		const now = options.now || Date.now
		const file = this.lockFile(workspaceId, dir)
		await fs.promises.mkdir(path.dirname(file), { recursive: true })
		// 等待超时用真实时钟：now 只用于判定心跳新鲜度，注入它不能把等待变成死循环
		const startedAt = Date.now()
		/** @type {import("node:fs/promises").FileHandle|null} */
		let handle = null
		while (!handle) {
			try {
				handle = await fs.promises.open(file, "wx")
			} catch (error) {
				if (error.code !== "EEXIST") throw error
				const info = await this.#readLock(file)
				// 锁文件缺失或内容损坏都按失效处理；只有明确的活心跳才视为被占用
				if (!info || now() - info.heartbeatAt > staleMs) {
					await fs.promises.rm(file, { force: true })
					continue
				}
				if (Date.now() - startedAt > timeoutMs) {
					const timeout = new Error(`等待目录锁超时（${timeoutMs}ms）：${dir}`)
					timeout.code = "LOCK_TIMEOUT"
					throw timeout
				}
				await delay(LOCK_RETRY_MS)
			}
		}
		const writeInfo = async () => {
			const payload = JSON.stringify({ owner, pid: process.pid, heartbeatAt: now() })
			await handle.truncate(0)
			await handle.write(payload, 0, "utf8")
		}
		try {
			await writeInfo()
		} catch (error) {
			// 写锁内容失败要立刻释放句柄与锁文件，否则会留下一个永远「新鲜」的空锁文件
			await handle.close().catch(() => {})
			await fs.promises.rm(file, { force: true }).catch(() => {})
			throw error
		}
		/** @type {NodeJS.Timeout|null} */
		let timer = null
		if (heartbeatMs > 0) {
			timer = setInterval(() => { writeInfo().catch(() => {}) }, heartbeatMs)
			timer.unref?.()
		}
		let released = false
		return {
			heartbeat: writeInfo,
			release: async () => {
				if (released) return
				released = true
				if (timer) clearInterval(timer)
				await handle.close().catch(() => {})
				// 只删自己的锁：可能已被判失效并被他方接管
				const info = await this.#readLock(file)
				if (!info || info.owner === owner) await fs.promises.rm(file, { force: true })
			},
		}
	}

	/**
	 * 读锁文件，损坏或缺失返回 null（按失效处理）。
	 * @param {string} file
	 * @returns {Promise<{ owner?: string, pid?: number, heartbeatAt: number }|null>}
	 */
	async #readLock(file) {
		try {
			const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"))
			if (parsed && typeof parsed.heartbeatAt === "number") return parsed
			// 内容坏掉时退回文件 mtime，避免无心跳信息的锁永远占位
			const stat = await fs.promises.stat(file)
			return { heartbeatAt: stat.mtimeMs }
		} catch (error) {
			if (error.code === "ENOENT") return null
			try { return { heartbeatAt: (await fs.promises.stat(file)).mtimeMs } } catch { return null }
		}
	}

	/**
	 * 清理某工作区下已失效的锁，返回清理数量。
	 * @param {string} workspaceId
	 * @param {{ staleMs?: number, now?: () => number }} [options]
	 * @returns {Promise<number>}
	 */
	async clearStaleLocks(workspaceId, options = {}) {
		const staleMs = options.staleMs ?? LOCK_STALE_MS
		const now = options.now || Date.now
		const dir = this.locksDir(workspaceId)
		let names
		try {
			names = await fs.promises.readdir(dir)
		} catch (error) {
			if (error.code === "ENOENT") return 0
			throw error
		}
		let cleared = 0
		for (const name of names) {
			if (!name.endsWith(".lock")) continue
			const file = path.join(dir, name)
			const info = await this.#readLock(file)
			if (info && now() - info.heartbeatAt <= staleMs) continue
			await fs.promises.rm(file, { force: true })
			cleared++
		}
		return cleared
	}
}

module.exports = {
	SkillJobs,
	JOBS_DIR,
	LOCKS_DIR,
	JOBS_VERSION,
	HEARTBEAT_MS,
	LOCK_STALE_MS,
	LOCK_TIMEOUT_MS,
}
