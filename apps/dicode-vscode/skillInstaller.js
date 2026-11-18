/**
 * 市场安装管道（阶段 3）。
 *
 * 口径见 docs/dicode-skill-market.md 第 5.3/5.4/8 节：
 * - 管道十步（8.1）：门禁 → 冲突预检 → 去重 → 下载（zip sha256 自算）→ CRC/大小校验
 *   → 暂存解压 → 技能根定位与目录名校验 → SKILL.md 身份校验 → 覆盖切换与登记 → 索引刷新 → 清理；
 * - 去重与并发（8.2）：同 (workspaceId, skillId, version) 去重依据任务表；每工作区并发
 *   上限 2；同一技能不同版本串行；目录写入用 skillsJobs 的心跳锁；
 * - 覆盖与回滚（8.3）：同 skillId 升级走 commitStaged 的 .bak 交换，失败还原登记不变；
 *   其他 skillId 或未登记目录占用报 DIR_CONFLICT（不可重试），不改名不覆盖；
 * - 事件：任务内 seq 从 0 单调递增，每阶段至少一条；queued/downloading/verifying/
 *   extracting/registering/done/failed；事件经 SkillJobs.appendEvent 幂等持久化，
 *   同任务事件经 promise 链串行下发，进度允许丢、状态不允许乱序。
 *
 * 失败一律抛 InstallerError（code 取 skillsModel 错误码，retryable 由 errorInfo 推导），
 * 管道外层捕获后转为 failed 事件写任务表并推给 webview。
 */

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const {
	JOB_STATES,
	TERMINAL_JOB_STATES,
	SOURCES,
	workspaceIdFor,
	errorInfo,
} = require('./skillsModel')
const archive = require('./skillArchive')

/** 每工作区并发安装上限（8.2）：在跑（非 queued、非终态）任务数 */
const MAX_CONCURRENT_INSTALLS = 2
/** 下载落盘目录（globalStorageUri/downloads） */
const DOWNLOADS_DIR = 'downloads'

class InstallerError extends Error {
	/**
	 * @param {string} code 7.1 错误码
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || errorInfo(code).message)
		this.name = 'InstallerError'
		this.code = code
		this.retryable = errorInfo(code).retryable
	}
}

/**
 * zip 字节 → `sha256:<hex>` 包摘要（8.1 步骤 4：服务端无摘要，客户端自算）。
 * @param {Buffer} bytes
 */
function zipDigest(bytes) {
	return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * 冲突判定（8.3，登记维度）。市场安装是无人值守流程，同名一律阻断：
 * - 目标目录未被他技能登记占用；
 * - 同一 skillId 已登记 → 升级（走覆盖管道，登记版本保持到写入成功才变）；
 *   升级时目标目录与旧登记不同视为新目录安装（旧目录转 missing，不自动删）。
 * 文件系统维度的占用（未登记目录）由调用方查存在性后按 DIR_CONFLICT 处理。
 * @param {Array<{ skillId: string, dir: string, source: string, version: string }>} records 登记快照
 * @param {string} dirName 包内技能根目录名（即目标目录名）
 * @param {string} skillId
 * @returns {{ mode: 'fresh'|'upgrade'|'new-dir-for-known-skill', previous?: { dir: string, version: string } }}
 */
function decideConflict(records, dirName, skillId) {
	const relative = `.agents/skills/${dirName}`
	const occupied = records.find(item => item.dir === relative && item.skillId !== skillId)
	if (occupied) throw new InstallerError('DIR_CONFLICT', `目标目录已被其他技能占用：${dirName}`)
	const own = records.filter(item => item.skillId === skillId && item.source === SOURCES.MARKET)
	if (own.length > 0) {
		const previous = own[0]
		if (previous.dir === relative) return { mode: 'upgrade', previous: { dir: relative, version: previous.version } }
		// 同一技能换目录名：视为新目录安装，旧目录保持不动（转 missing 由视图标注）
		return { mode: 'new-dir-for-known-skill', previous: { dir: previous.dir, version: previous.version } }
	}
	return { mode: 'fresh' }
}

/** @param {string} dir 登记里的相对目录（.agents/skills/<名>） */
function dirNameOf(dir) {
	return String(dir || '').replace(/^\.agents\/skills\//, '')
}

/**
 * @param {Object} options
 * @param {string} options.workspace 工作区绝对路径（登记与安装目录所在）
 * @param {string} options.storageDir globalStorageUri.fsPath（任务表/锁/下载暂存所在）
 * @param {string} [options.workspaceId] 缺省按 workspace 路径推导
 * @param {import('./skillsJobs').SkillJobs} options.jobs 任务表实例
 * @param {() => Promise<(request: any) => Promise<any>>|null} options.transportFactory
 *   惰性取市场 transport（未配置返回 null）
 * @param {(transport: any, skillId: string, version?: string) => Promise<any>} options.fetchDetail
 *   详情拼装（skillMarket.fetchSkillDetail），门禁与身份校验数据来源
 * @param {(transport: any, skillId: string, version: string, options?: any) => Promise<Buffer>} options.download
 *   固定版本下载（skillMarket.fetchDownload）
 * @param {(workspace: string, record: any) => Promise<any[]>} options.upsertRecord 登记写入
 * @param {() => Promise<boolean>} options.reloadIndex 安装成功后刷新 Codex 索引（skills/list forceReload），
 *   true 表示刷新成功（extension 侧把 readSkillIndex 的 available/error 折叠成布尔）
 * @param {(payload: Record<string, any>) => void} options.postEvent 推送 installEvent 到 webview
 * @param {() => Promise<void>} [options.onFinished] 任务终态后的联动回调（推 installedSkills 等）
 * @param {{ maxConcurrent?: number, now?: () => number }} [options.tuning] 测试注入
 */
function createInstaller(options) {
	const {
		workspace,
		storageDir,
		jobs,
		upsertRecord,
		reloadIndex,
		postEvent,
	} = options
	const workspaceId = options.workspaceId || workspaceIdFor(workspace)
	const skillsRoot = path.join(workspace, '.agents', 'skills')
	const downloadsDir = path.join(storageDir, DOWNLOADS_DIR)
	const maxConcurrent = options.tuning?.maxConcurrent ?? MAX_CONCURRENT_INSTALLS
	const now = options.tuning?.now || (() => Date.now())

	/** 内存待执行队列（queued 任务按提交顺序推进），元素为内存 job 对象 */
	const pendingJobs = []
	/** install/retry 提交串行链：去重检查与任务创建原子化（连续点击/并发提交不产生重复任务） */
	let installChain = Promise.resolve()
	/** 本进程已启动未终态的任务（runJob 启动到首条 downloading 事件写表之间，任务表里仍是 queued，计数靠这里） */
	const activeJobs = new Map()
	/** pump 互斥：runJob 终态后 pump() 可能与新任务入队的 pump() 并发，用重入标记合并成下一轮 */
	let pumpRunning = false
	let pumpAgain = false

	const transportFactory = options.transportFactory
	const fetchDetail = options.fetchDetail
	const download = options.download

	/**
	 * 发射事件：seq 同步自增（保证单调）→ appendEvent 幂等持久化 → 推 webview。
	 * 同任务事件经 promise 链串行，避免并发进度事件交错写任务表。
	 * @param {{ jobId: string, skillId: string, version: string, seq: number, startedAt: number, emitChain?: Promise<void> }} job
	 * @param {Record<string, any>} fields state/progress/digest/errorCode/errorMessage/retryable
	 */
	function emitQueued(job, fields) {
		const event = {
			jobId: job.jobId,
			workspaceId,
			skillId: job.skillId,
			version: job.version,
			startedAt: job.startedAt,
			seq: job.seq++,
			...fields,
		}
		job.emitChain = (job.emitChain || Promise.resolve())
			.then(async () => {
				await jobs.appendEvent(event)
				postEvent(event)
			})
		return job.emitChain
	}

	/**
	 * 提交失败/执行失败的错误统一转 InstallerError。
	 * MarketError / SkillArchiveError 已带 7.1 码，直接借用其 code。
	 * @param {unknown} error
	 * @returns {InstallerError}
	 */
	function toInstallerError(error) {
		if (error instanceof InstallerError) return error
		const code = error && typeof error.code === 'string' && errorInfo(error.code) ? error.code : 'NETWORK'
		return new InstallerError(code, error && error.message)
	}

	/**
	 * 读登记快照（冲突判定用）。
	 */
	async function readRecords() {
		const { readRegistry } = require('./skillsRegistry')
		const { skills } = await readRegistry(workspace)
		return skills
	}

	/**
	 * 市场安装门禁（8.1 步骤 1）：compat 必须为 compatible；
	 * 目标版本必须 status === 'PUBLISHED' && downloadReady === true。
	 * 提交时与执行时各校验一次：提交处给同步错误反馈，执行处兜底排队期间的状态变化。
	 * @param {string} skillId
	 * @param {string} version
	 * @returns {Promise<{ skill: Record<string, any> }>}
	 */
	async function checkGate(skillId, version) {
		const transport = await transportFactory()
		if (!transport) throw new InstallerError('NETWORK', '市场服务未配置，无法安装')
		const detail = await fetchDetail(transport, skillId, version)
		const skill = detail.skill
		if (skill.compat === 'incompatible')
			throw new InstallerError('INCOMPATIBLE_CLIENT', skill.minClientVersion ? `该技能需要插件版本 ${skill.minClientVersion} 及以上` : undefined)
		if (skill.compat === 'restricted')
			throw new InstallerError('ORG_RESTRICTED', skill.compatReason)
		const entry = (detail.versions || []).find(item => item.version === version)
		if (!entry || entry.status !== 'PUBLISHED' || entry.downloadReady !== true)
			throw new InstallerError('NOT_FOUND', `版本 ${version} 不可下载（未发布或未就绪）`)
		return { skill }
	}

	/**
	 * 任务表去重（8.2）：同 skillId+version 的非终态任务直接复用（含 queued 与其他窗口写入的）。
	 * @param {string} skillId @param {string} version
	 */
	async function findActiveJob(skillId, version) {
		const list = await jobs.snapshot(workspaceId)
		return list.find(job => job.skillId === skillId && job.version === version && !TERMINAL_JOB_STATES.includes(job.state))
	}

	/** 在跑（非 queued、非终态）任务数：本进程 activeJobs + 任务表里其他来源的在跑任务。 */
	async function runningCount() {
		const list = await jobs.snapshot(workspaceId)
		const external = list.filter(job => job.state !== JOB_STATES.QUEUED
			&& !TERMINAL_JOB_STATES.includes(job.state)
			&& !activeJobs.has(job.jobId)).length
		return external + activeJobs.size
	}

	/**
	 * 同一技能是否有其他在跑任务（不同版本串行，8.2）。
	 * @param {string} skillId @param {string} excludeJobId
	 */
	async function hasRunningForSkill(skillId, excludeJobId) {
		for (const job of activeJobs.values()) {
			if (job.skillId === skillId && job.jobId !== excludeJobId) return true
		}
		const list = await jobs.snapshot(workspaceId)
		return list.some(job => job.skillId === skillId
			&& job.jobId !== excludeJobId
			&& job.state !== JOB_STATES.QUEUED
			&& !TERMINAL_JOB_STATES.includes(job.state)
			&& !activeJobs.has(job.jobId))
	}

	/**
	 * 队列泵：按提交顺序把 queued 任务推进到执行。
	 * 单实例互斥 + 重入唤醒：终态回调与新任务入队都唤起下一轮检查，避免竞态多启动。
	 */
	async function pump() {
		if (pumpRunning) {
			pumpAgain = true
			return
		}
		pumpRunning = true
		try {
			do {
				pumpAgain = false
				for (;;) {
					const head = pendingJobs[0]
					if (!head) break
					if ((await runningCount()) >= maxConcurrent) break
					if (await hasRunningForSkill(head.skillId, head.jobId)) break
					pendingJobs.shift()
					runJob(head).catch(() => {})
				}
			} while (pumpAgain)
		} finally {
			pumpRunning = false
		}
	}

	/**
	 * 新任务：seq 从 0 起，首条事件 state=queued。
	 * @param {{ skillId: string, version: string }} spec
	 */
	function createJob(spec) {
		/** @type {{ jobId: string, workspaceId: string, skillId: string, version: string, state: string, seq: number, retryable: boolean, startedAt: number, emitChain?: Promise<void> }} */
		const job = {
			jobId: `${now()}-${crypto.randomBytes(6).toString('hex')}`,
			workspaceId,
			skillId: spec.skillId,
			version: spec.version,
			state: JOB_STATES.QUEUED,
			seq: 0,
			retryable: false,
			startedAt: now(),
		}
		emitQueued(job, { state: JOB_STATES.QUEUED })
		pendingJobs.push(job)
		return job
	}

	/**
	 * retry 的实际执行体（经 installChain 串行）。
	 * @param {string} oldJobId
	 */
	async function doRetry(oldJobId) {
		if (!workspace) throw new InstallerError('NETWORK', '请先打开工作区')
		const list = await jobs.snapshot(workspaceId)
		const old = list.find(item => item.jobId === oldJobId)
		if (!old) throw new InstallerError('NOT_FOUND', '任务不存在或已被清理')
		if (old.state === JOB_STATES.DONE) throw new Error('任务已成功，无需重试')
		if (old.state !== JOB_STATES.FAILED || old.retryable !== true)
			throw new Error('该任务不可重试')
		const job = createJob({ skillId: old.skillId, version: old.version })
		await job.emitChain
		await pump()
		return { jobId: job.jobId }
	}

	/**
	 * install 的实际执行体（经 installChain 串行）：去重 → 门禁 → 建任务 → 泵。
	 * @param {string} skillId
	 * @param {string} version
	 */
	async function doInstall(skillId, version) {
		if (!workspace) throw new InstallerError('NETWORK', '请先打开工作区')
		const active = await findActiveJob(skillId, version)
		if (active) return { jobId: active.jobId, reused: true }
		await checkGate(skillId, version)
		const job = createJob({ skillId, version })
		await job.emitChain // queued 事件已持久化，后续 install 的去重才能看到它
		await pump()
		return { jobId: job.jobId, reused: false }
	}

	/**
	 * 执行一条任务（8.1 步骤 2-10）。失败统一转 failed 事件；成功落 done。
	 * 终态后 pump 唤醒后续任务。
	 * @param {{ jobId: string, skillId: string, version: string, seq: number, startedAt: number, emitChain?: Promise<void> }} job
	 */
	async function runJob(job) {
		activeJobs.set(job.jobId, job)
		/** @type {string} */
		let stagingRoot = ''
		let zipFile = ''
		try {
			const { skill } = await checkGate(job.skillId, job.version)

			// 下载前预检（8.1 步骤 1）：旧登记可预判的登记占用，避免下载完才失败。
			// 包内目录名下载前未知（服务端不提供），未登记目录的占用在解压后终判。
			const records = await readRecords()
			const ownRecord = records.find(item => item.skillId === job.skillId && item.source === SOURCES.MARKET)
			if (ownRecord) decideConflict(records, dirNameOf(ownRecord.dir), job.skillId)

			// 下载：写 downloads/<jobId>.zip（8.1 步骤 3），进度按回调节流上报
			const transport = await transportFactory()
			if (!transport) throw new InstallerError('NETWORK', '市场服务未配置，无法安装')
			await fs.mkdir(downloadsDir, { recursive: true })
			zipFile = path.join(downloadsDir, `${job.jobId}.zip`)
			let lastProgress = 0
			const bytes = await download(transport, job.skillId, job.version, {
				onProgress: (loaded, total) => {
					if (!total) return
					const progress = Math.min(100, Math.round((loaded / total) * 100))
					if (progress - lastProgress >= 5 || progress === 100) {
						lastProgress = progress
						emitQueued(job, { state: JOB_STATES.DOWNLOADING, progress })
					}
				},
			})
			await fs.writeFile(zipFile, bytes)
			const digest = zipDigest(bytes)
			await emitQueued(job, { state: JOB_STATES.DOWNLOADING, progress: 100, digest })

			// 校验 + 解压到目标同级暂存目录（8.1 步骤 4-6；CRC/声明大小由解析器校验）
			await emitQueued(job, { state: JOB_STATES.VERIFYING })
			await fs.mkdir(skillsRoot, { recursive: true })
			const extracted = await archive.extractArchive({ buffer: bytes, skillsRoot, tempId: job.jobId })
			stagingRoot = extracted.stagingRoot
			await emitQueued(job, { state: JOB_STATES.EXTRACTING })

			// 身份校验（8.1 步骤 7）：SKILL.md 的 name 必须与 slug 或 displayName 之一一致
			const metaName = extracted.meta.name
			if (metaName !== skill.slug && metaName !== skill.name)
				throw new InstallerError('SOURCE_VERIFY_FAILED', `包内技能名 ${metaName} 与目录项（${skill.slug} / ${skill.name}）不一致`)

			// 冲突终判（8.3）：以包内根目录名为准，叠加文件系统占用检查
			const decision = decideConflict(records, extracted.dirName, job.skillId)
			const targetExists = await fs.lstat(path.join(skillsRoot, extracted.dirName)).then(() => true, () => false)
			if (decision.mode === 'fresh' && targetExists)
				throw new InstallerError('DIR_CONFLICT', `目标目录已存在且未登记：${extracted.dirName}`)
			const replace = decision.mode === 'upgrade' || targetExists

			// 登记与目录切换（8.1 步骤 8）：同一目录的写入加锁（8.2）
			await emitQueued(job, { state: JOB_STATES.REGISTERING })
			const lock = await jobs.acquireLock(workspaceId, extracted.dirName, { timeoutMs: options.tuning?.lockTimeoutMs })
			try {
				await archive.commitStaged({
					stagingRoot,
					stagingSkillPath: extracted.stagingSkillPath,
					skillsRoot,
					dirName: extracted.dirName,
					replace,
				})
				stagingRoot = ''

				// 索引刷新（8.1 步骤 9 / 8.5）：失败标 indexStale，不算安装失败
				let indexStale = false
				try {
					indexStale = !(await reloadIndex())
				} catch {
					indexStale = true
				}

				await upsertRecord(workspace, {
					skillId: job.skillId,
					name: metaName,
					version: job.version,
					digest,
					dirDigest: extracted.digest,
					dir: `.agents/skills/${extracted.dirName}`,
					source: SOURCES.MARKET,
					origin: extracted.dirName,
					installedAt: now(),
					publisher: skill.publisher,
					summary: skill.summary,
					tags: skill.tags,
					...(indexStale ? { indexStale: true } : {}),
				})
			} finally {
				await lock.release()
			}

			await emitQueued(job, { state: JOB_STATES.DONE, digest })
		} catch (error) {
			const installerError = toInstallerError(error)
			await emitQueued(job, {
				state: JOB_STATES.FAILED,
				errorCode: installerError.code,
				errorMessage: installerError.message,
				retryable: installerError.retryable,
			}).catch(() => {})
		} finally {
			// 清理（8.1 步骤 10）：临时 zip 与暂存目录，无论成败
			if (zipFile) await fs.rm(zipFile, { force: true }).catch(() => {})
			if (stagingRoot) await archive.discardStaged(stagingRoot)
			activeJobs.delete(job.jobId)
			if (options.onFinished) await options.onFinished().catch(() => {})
			await pump().catch(() => {})
		}
	}

	return {
		workspaceId,
		skillsRoot,
		/**
		 * 提交安装（marketInstall）。去重在前（在跑/queued 任务直接复用，连续点击不重复走
		 * 门禁往返，也消除并发提交窗口）；门禁不过直接抛错（不产生任务），执行时 runJob
		 * 内还有一次门禁兜底。提交顺序经内部串行链（8.1 步骤顺序调整：去重提前，14 备案）。
		 * @param {string} skillId
		 * @param {string} version
		 * @returns {Promise<{ jobId: string, reused: boolean }>}
		 */
		install(skillId, version) {
			const result = installChain.then(
				() => doInstall(skillId, version),
				() => doInstall(skillId, version),
			)
			installChain = result.then(() => undefined, () => undefined)
			return result
		},
		/**
		 * 重试可重试的失败任务（marketRetry）：新 jobId，不复用旧 ID（5.4）。
		 * 提交经同一串行链，与 install 的去重检查互斥。
		 * @param {string} oldJobId
		 * @returns {Promise<{ jobId: string }>}
		 */
		retry(oldJobId) {
			const result = installChain.then(
				() => doRetry(oldJobId),
				() => doRetry(oldJobId),
			)
			installChain = result.then(() => undefined, () => undefined)
			return result
		},
		/**
		 * 任务快照（getInstallJobs / installJobs）：在跑 + 失败；done 不含，以登记重建（8.4）。
		 * 同 skillId+version 已有更新任务时排除旧条目（重试接棒后旧失败不再暴露给 UI）。
		 * @returns {Promise<import('./skillsModel').InstallJob[]>}
		 */
		async snapshot() {
			const list = await jobs.snapshot(workspaceId)
			return list.filter(job => job.state !== JOB_STATES.DONE)
				.filter(job => !list.some(other =>
					other.jobId !== job.jobId
					&& other.skillId === job.skillId
					&& other.version === job.version
					&& (other.startedAt || 0) > (job.startedAt || 0)))
		},
		/**
		 * 扩展启动恢复（8.4）：非终态任务置 failed + INTERRUPTED，并清理残留临时文件。
		 * @returns {Promise<{ interrupted: number, cleaned: number }>}
		 */
		async recover() {
			const { interrupted } = await jobs.recover(workspaceId)
			let cleaned = 0
			// 残留暂存目录 .tmp-*（目标同级，8.1）
			try {
				for (const name of await fs.readdir(skillsRoot)) {
					if (!name.startsWith(archive.STAGING_PREFIX)) continue
					await fs.rm(path.join(skillsRoot, name), { recursive: true, force: true })
					cleaned++
				}
			} catch (error) {
				if (error.code !== 'ENOENT') throw error
			}
			// 残留下载 zip
			try {
				for (const name of await fs.readdir(downloadsDir)) {
					await fs.rm(path.join(downloadsDir, name), { force: true })
					cleaned++
				}
			} catch (error) {
				if (error.code !== 'ENOENT') throw error
			}
			return { interrupted, cleaned }
		},
		/**
		 * 索引重试（8.5）：独立动作，与安装重试不共用 jobId。
		 * 成功清除登记 indexStale；返回刷新后是否仍有 stale。
		 * @param {string} skillId
		 */
		async refreshIndex(skillId) {
			const { readRegistry, upsertRecord: upsert } = require('./skillsRegistry')
			const { skills } = await readRegistry(workspace)
			const record = skills.find(item => item.skillId === skillId && item.source === SOURCES.MARKET)
			if (!record) throw new InstallerError('NOT_FOUND', '登记不存在')
			let ok = false
			try {
				ok = await reloadIndex()
			} catch {
				ok = false
			}
			if (ok && record.indexStale) await upsert(workspace, { ...record, indexStale: false })
			return { ok, indexStale: !ok }
		},
	}
}

module.exports = {
	InstallerError,
	createInstaller,
	decideConflict,
	zipDigest,
	DOWNLOADS_DIR,
	MAX_CONCURRENT_INSTALLS,
}
