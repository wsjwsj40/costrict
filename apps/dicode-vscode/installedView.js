/**
 * 【已安装】页签的数据合并（阶段 1）。
 *
 * 口径见 docs/dicode-skill-market.md 3.2 / 9 节：
 * - 数据源是本机技能索引 ∪ 工作区登记，两侧按 dir 取并集，任一侧都不是唯一主体；
 * - 登记有、目录无 → missing；目录有、登记无 → external；登记有、目录在但索引没刷新 → indexStale；
 * - 排除 .tmp-*、*.new、*.bak 残留目录，别把它们当成手工放置的技能；
 * - 元数据不向远程请求：登记项取登记，手工放置项取 SKILL.md frontmatter。
 *
 * 这里只做合并与来源判定，过滤/搜索/排序展示层在 webview/skills.ts。
 */

const fs = require("node:fs")
const path = require("node:path")
const { SOURCES, SKILLS_DIR_SEGMENTS, LOCAL_VERSION } = require("./skillsModel")

/** 读 frontmatter 时最多读这么多字节，避免为了两个字段把大文件读进来 */
const FRONTMATTER_READ_LIMIT = 8192

/**
 * 残留目录：隐藏目录（含 .tmp-*）与 .new / .bak 备份，都不算技能项。
 * @param {string} name
 * @returns {boolean}
 */
function isResidualName(name) {
	return name.startsWith(".") || /\.(?:new|bak)$/i.test(name)
}

/**
 * 取 frontmatter 里某个单行字段，去掉包裹的引号。
 * @param {string} block
 * @param {string} key
 * @returns {string}
 */
function frontmatterField(block, key) {
	const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)
	if (!match) return ""
	return match[1].trim().replace(/^["']/, "").replace(/["']$/, "").trim()
}

/**
 * 解析 SKILL.md 的 frontmatter。读不到文件或没有 frontmatter 都返回空对象，
 * 让调用方用目录名兜底显示，不因为一个坏文件让整页失败。
 * @param {string} dirPath
 * @returns {Promise<{ name?: string, description?: string } | null>} null 表示没有 SKILL.md
 */
async function readSkillMeta(dirPath) {
	let text
	try {
		const handle = await fs.promises.open(path.join(dirPath, "SKILL.md"), "r")
		try {
			const buffer = Buffer.alloc(FRONTMATTER_READ_LIMIT)
			const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_READ_LIMIT, 0)
			text = buffer.subarray(0, bytesRead).toString("utf8")
		} finally {
			await handle.close()
		}
	} catch {
		return null
	}
	const block = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/.exec(text)?.[1]
	if (!block) return {}
	return { name: frontmatterField(block, "name"), description: frontmatterField(block, "description") }
}

/**
 * 扫描技能目录。只读一层，不递归；残留目录与文件跳过。
 * @param {string} skillsRoot <workspace>/.agents/skills
 * @returns {Promise<Array<{ dir: string, dirPath: string, hasSkillMd: boolean, name?: string, description?: string }>>}
 */
async function scanSkillDirs(skillsRoot) {
	let entries
	try {
		entries = await fs.promises.readdir(skillsRoot, { withFileTypes: true })
	} catch (error) {
		if (error.code === "ENOENT") return []
		throw error
	}
	const dirs = []
	for (const entry of entries) {
		if (!entry.isDirectory() || isResidualName(entry.name)) continue
		const dirPath = path.join(skillsRoot, entry.name)
		const meta = await readSkillMeta(dirPath)
		dirs.push({ dir: entry.name, dirPath, hasSkillMd: meta !== null, name: meta?.name || "", description: meta?.description || "" })
	}
	return dirs
}

/**
 * 从登记项的 dir（`.agents/skills/<目录名>`）取目录名。
 * @param {import("./skillsModel").InstallRecord} record
 * @returns {string}
 */
function dirFromRecord(record) {
	return String(record.dir || "").split("/").filter(Boolean).pop() || ""
}

/**
 * 从索引项的 path（`<skillsRoot>/<目录名>/SKILL.md`）取目录名。
 * @param {string} skillsRoot
 * @param {string} skillPath
 * @returns {string} 不在技能目录下时返回空串
 */
function dirFromIndexPath(skillsRoot, skillPath) {
	if (!skillPath) return ""
	const relative = path.relative(skillsRoot, skillPath)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return ""
	const parts = relative.split(path.sep).filter(Boolean)
	// 至少要有 <目录名>/<文件>；直接放在根部的 SKILL.md 归不到任何目录
	return parts.length >= 2 ? parts[0] : ""
}

/**
 * 合并索引与登记，得到【已安装】列表。
 * @param {Object} options
 * @param {string} options.workspace
 * @param {import("./skillsModel").InstallRecord[]} [options.records]
 * @param {Array<{ name?: string, description?: string, path?: string, enabled?: boolean, scope?: string }>} [options.index] 来自 skills/list
 * @param {Array<{ dir: string, dirPath?: string, hasSkillMd?: boolean, name?: string, description?: string }>} [options.scanned] 来自 scanSkillDirs
 * @param {boolean} [options.indexAvailable] CLI 不可用时为 false：不标 indexStale、enabled 显示未知
 * @returns {Array<Record<string, any>>}
 */
function buildInstalledView(options = {}) {
	const { workspace, records = [], index = [], scanned = [], indexAvailable = true } = options
	const skillsRoot = path.join(workspace, ...SKILLS_DIR_SEGMENTS)
	/** @type {Map<string, any>} */
	const byDir = new Map()

	const create = dir => ({
		dir,
		dirPath: path.join(skillsRoot, dir),
		name: dir,
		summary: "",
		version: null,
		source: SOURCES.EXTERNAL,
		installedAt: null,
		enabled: null,
		scope: null,
		path: null,
		missing: false,
		external: true,
		indexStale: false,
		altered: false,
		record: null,
		tags: [],
	})

	// 1. 磁盘事实：先放所有真实存在的目录，默认按手工放置。
	// 没有 SKILL.md 的目录不建条目——Agent 发现不了它，不是技能项；但目录本身的「存在」仍要记住，
	// 用于判定登记项是目录缺失（missing）还是仅内容不完整。
	const diskDirs = new Set(scanned.map(item => item.dir))
	for (const item of scanned) {
		if (isResidualName(item.dir) || item.hasSkillMd === false) continue
		const entry = create(item.dir)
		if (item.dirPath) entry.dirPath = item.dirPath
		if (item.name) entry.name = item.name
		if (item.description) entry.summary = item.description
		byDir.set(item.dir, entry)
	}

	// 2. 登记：market / import 覆盖来源与元数据；目录不存在时标 missing 但保留该项
	for (const record of records) {
		if (record.source !== SOURCES.MARKET && record.source !== SOURCES.IMPORT) continue
		const dir = dirFromRecord(record)
		if (!dir) continue
		const existing = byDir.get(dir)
		const entry = existing || create(dir)
		entry.name = record.name || entry.name
		entry.summary = record.summary || entry.summary
		entry.version = record.version || (record.source === SOURCES.IMPORT ? LOCAL_VERSION : entry.version)
		entry.source = record.source
		entry.installedAt = typeof record.installedAt === "number" ? record.installedAt : null
		entry.external = false
		entry.record = record
		entry.tags = Array.isArray(record.tags) ? record.tags : []
		if (record.publisher) entry.publisher = record.publisher
		entry.altered = record.altered === true
		entry.missing = !diskDirs.has(dir)
		byDir.set(dir, entry)
	}

	// 3. 索引：补 enabled / scope / path；索引里有但登记没有的，是手工放置项
	const indexedDirs = new Set()
	for (const skill of index) {
		const dir = dirFromIndexPath(skillsRoot, skill.path)
		if (!dir) continue
		indexedDirs.add(dir)
		const existing = byDir.get(dir)
		const entry = existing || create(dir)
		entry.enabled = typeof skill.enabled === "boolean" ? skill.enabled : null
		entry.scope = skill.scope || null
		entry.path = skill.path || null
		entry.missing = false
		if (!entry.summary && skill.description) entry.summary = skill.description
		if ((!entry.name || entry.name === dir) && skill.name) entry.name = skill.name
		byDir.set(dir, entry)
	}

	// 4. 索引新鲜度：登记项目录在、索引可用却没有它 → 索引没刷新
	if (indexAvailable) {
		for (const entry of byDir.values()) {
			if (entry.record && !entry.missing && !indexedDirs.has(entry.dir)) entry.indexStale = true
		}
	} else {
		for (const entry of byDir.values()) entry.indexStale = entry.record?.indexStale === true
	}

	// 5. 名称稳定排序，源标签不做分组，避免安装后条目跳位
	return [...byDir.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.dir.localeCompare(b.dir))
}

module.exports = {
	FRONTMATTER_READ_LIMIT,
	isResidualName,
	readSkillMeta,
	scanSkillDirs,
	dirFromRecord,
	dirFromIndexPath,
	buildInstalledView,
}
