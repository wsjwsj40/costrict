/**
 * 技能包归档层（阶段 1）。
 *
 * 口径见 docs/dicode-skill-market.md 9.2 / 8.1：
 * - 解析器自研，只依赖 node:zlib，不给扩展宿主新增运行时依赖；
 * - 只支持 store 与 deflate，逐条校验 CRC32 与声明大小，不信任包头里的解压后体积；
 * - 拒绝绝对路径、含 `..`、反斜杠、控制字符、符号链接、加密条目、zip64；
 * - 限额：包 ≤ 20MB、解压总量 ≤ 100MB、文件数 ≤ 500、单文件 ≤ 10MB；
 * - 解压到目标同级的 `.tmp-<id>` 暂存目录，校验通过后再 rename，失败只清暂存。
 *
 * 错误统一用 `SkillArchiveError`，`code` 取 skillsModel 的错误码名，
 * 便于直接映射到 UI 与任务日志。
 */

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")
const { ERROR_CODES, validateDirName } = require("./skillsModel")

const ARCHIVE_LIMITS = Object.freeze({
	maxArchiveBytes: 20 * 1024 * 1024,
	maxTotalBytes: 100 * 1024 * 1024,
	maxEntries: 500,
	maxEntryBytes: 10 * 1024 * 1024,
})

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_BYTES = 22
const MAX_COMMENT_BYTES = 0xffff
const ZIP64_SENTINEL = 0xffffffff

/** 暂存目录前缀，与 installedView 的残留判定一致 */
const STAGING_PREFIX = ".tmp-"

class SkillArchiveError extends Error {
	/**
	 * @param {keyof typeof ERROR_CODES} code
	 * @param {string} message
	 * @param {Record<string, any>} [extra]
	 */
	constructor(code, message, extra = {}) {
		super(message)
		this.name = "SkillArchiveError"
		this.code = ERROR_CODES[code] ? code : "ARCHIVE_INVALID"
		this.kind = extra.kind || ""
		Object.assign(this, extra)
	}
}

/** CRC32 查表，解压后逐条比对中央目录里声明的值 */
const CRC_TABLE = (() => {
	const table = new Int32Array(256)
	for (let index = 0; index < 256; index += 1) {
		let value = index
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		table[index] = value
	}
	return table
})()

/**
 * @param {Buffer} buffer
 * @returns {number} 无符号 32 位 CRC
 */
function crc32(buffer) {
	let crc = -1
	for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
	return (crc ^ -1) >>> 0
}

/**
 * 从尾部找 EOCD。注释最长 65535 字节，所以只需回看 64KB+22。
 * @param {Buffer} buffer
 * @returns {number} EOCD 起始偏移
 */
function findEocd(buffer) {
	const start = Math.max(0, buffer.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES)
	for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
	}
	throw new SkillArchiveError("ARCHIVE_INVALID", "不是有效的 ZIP 文件（找不到中央目录）")
}

/**
 * 校验条目路径：只接受正斜杠分隔的相对路径。
 * @param {string} name
 * @param {{ isDirectory: boolean }} meta
 */
function assertSafeEntryName(name, meta) {
	if (!name) throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包内存在空文件名")
	if (name.includes("\\")) throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内路径含反斜杠：${name}`)
	if (name.startsWith("/")) throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内含绝对路径：${name}`)
	if (/^[a-zA-Z]:/.test(name)) throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内含绝对路径：${name}`)
	if (name.includes("\u0000")) throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包内路径含控制字符")
	for (const char of name) {
		if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
			throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包内路径含控制字符")
	}
	const segments = name.split("/")
	for (const segment of segments) {
		if (segment === "..") throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内含向上穿越路径：${name}`)
		if (segment === "." && !meta.isDirectory) throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内含非法路径：${name}`)
	}
}

/**
 * 解析中央目录，返回条目元数据（不含内容）。
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, isDirectory: boolean, isSymlink: boolean, encrypted: boolean, method: number, crc: number, compressedSize: number, uncompressedSize: number, dataOffset: number }>}
 */
function readZipEntries(buffer) {
	if (!Buffer.isBuffer(buffer) || !buffer.length) throw new SkillArchiveError("ARCHIVE_INVALID", "技能包为空")
	if (buffer.length > ARCHIVE_LIMITS.maxArchiveBytes)
		throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `技能包超过 ${Math.round(ARCHIVE_LIMITS.maxArchiveBytes / 1024 / 1024)}MB 限制`)

	const eocd = findEocd(buffer)
	const totalEntries = buffer.readUInt16LE(eocd + 10)
	const centralSize = buffer.readUInt32LE(eocd + 12)
	const centralOffset = buffer.readUInt32LE(eocd + 16)

	if (totalEntries === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL)
		throw new SkillArchiveError("ARCHIVE_TOO_LARGE", "不支持 ZIP64 格式的技能包")
	if (!totalEntries) throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包内没有文件")
	if (totalEntries > ARCHIVE_LIMITS.maxEntries)
		throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `压缩包内文件数超过 ${ARCHIVE_LIMITS.maxEntries} 个限制`)
	if (centralOffset + centralSize > buffer.length)
		throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包中央目录位置越界，文件可能已损坏")

	/** @type {Array<any>} */
	const entries = []
	let offset = centralOffset
	let totalBytes = 0
	for (let index = 0; index < totalEntries; index += 1) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
			throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包中央目录损坏")
		const versionMadeBy = buffer.readUInt16LE(offset + 4)
		const flags = buffer.readUInt16LE(offset + 8)
		const method = buffer.readUInt16LE(offset + 10)
		const crc = buffer.readUInt32LE(offset + 16)
		const compressedSize = buffer.readUInt32LE(offset + 20)
		const uncompressedSize = buffer.readUInt32LE(offset + 24)
		const nameLength = buffer.readUInt16LE(offset + 28)
		const extraLength = buffer.readUInt16LE(offset + 30)
		const commentLength = buffer.readUInt16LE(offset + 32)
		const externalAttrs = buffer.readUInt32LE(offset + 38)
		const localOffset = buffer.readUInt32LE(offset + 42)
		const nameStart = offset + 46
		if (nameStart + nameLength > buffer.length) throw new SkillArchiveError("ARCHIVE_INVALID", "压缩包中央目录损坏")
		const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8")
		offset = nameStart + nameLength + extraLength + commentLength

		const isDirectory = name.endsWith("/")
		const host = versionMadeBy >> 8
		const unixMode = (externalAttrs >>> 16) & 0xffff
		const isSymlink = host === 3 && (unixMode & 0xf000) === 0xa000
		assertSafeEntryName(name, { isDirectory })

		if (flags & 0x1) throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内含加密条目：${name}`)
		if (isSymlink) throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内含符号链接：${name}`)
		if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL)
			throw new SkillArchiveError("ARCHIVE_TOO_LARGE", "不支持 ZIP64 格式的技能包")
		if (!isDirectory) {
			if (method !== 0 && method !== 8)
				throw new SkillArchiveError("ARCHIVE_INVALID", `不支持的压缩方式（${method}）：${name}`)
			if (uncompressedSize > ARCHIVE_LIMITS.maxEntryBytes)
				throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `单个文件超过 ${Math.round(ARCHIVE_LIMITS.maxEntryBytes / 1024 / 1024)}MB 限制：${name}`)
			totalBytes += uncompressedSize
			if (totalBytes > ARCHIVE_LIMITS.maxTotalBytes)
				throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `解压后总量超过 ${Math.round(ARCHIVE_LIMITS.maxTotalBytes / 1024 / 1024)}MB 限制`)
		}

		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
			throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内条目头损坏：${name}`)
		const localNameLength = buffer.readUInt16LE(localOffset + 26)
		const localExtraLength = buffer.readUInt16LE(localOffset + 28)
		const dataOffset = localOffset + 30 + localNameLength + localExtraLength
		if (dataOffset + compressedSize > buffer.length)
			throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内条目数据越界：${name}`)

		entries.push({ name, isDirectory, isSymlink, encrypted: false, method, crc, compressedSize, uncompressedSize, dataOffset })
	}
	return entries
}

/**
 * 读出条目内容并校验 CRC 与声明大小。
 * @param {Buffer} buffer
 * @param {ReturnType<typeof readZipEntries>[number]} entry
 * @returns {Buffer}
 */
function readEntryData(buffer, entry) {
	if (entry.isDirectory) return Buffer.alloc(0)
	const raw = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
	let data
	if (entry.method === 0) data = Buffer.from(raw)
	else {
		try {
			data = zlib.inflateRawSync(raw)
		} catch (error) {
			throw new SkillArchiveError("ARCHIVE_CORRUPT", `解压失败：${entry.name}（${error.message}）`)
		}
	}
	if (data.length !== entry.uncompressedSize)
		throw new SkillArchiveError("ARCHIVE_CORRUPT", `解压后大小与声明不符：${entry.name}`)
	if (crc32(data) !== entry.crc) throw new SkillArchiveError("ARCHIVE_CORRUPT", `校验失败：${entry.name}`)
	return data
}

/**
 * 剥离包内单层根目录：所有条目都在同一个顶层目录下时把它当容器。
 * 仅用于展示/调试，落盘时以 SKILL.md 所在目录为准，避免把技能根目录名丢掉。
 * @param {Array<{ name: string }>} entries
 * @returns {string} 需要剥离的前缀（含结尾斜杠），无需剥离时为空串
 */
function singleRootPrefix(entries) {
	let root = ""
	for (const entry of entries) {
		const [first] = entry.name.split("/")
		if (!first) return ""
		if (!root) root = first
		else if (root !== first) return ""
	}
	// 只有「一个目录 + 目录内文件」才算单层容器；根目录直接放文件不算
	return entries.some(entry => !entry.name.endsWith("/") && entry.name.split("/").length > 1) ? `${root}/` : ""
}

/**
 * 解析 frontmatter 的 name / description。
 * @param {string} text
 * @returns {{ name: string, description: string }}
 */
function parseSkillFrontmatter(text) {
	const block = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/.exec(text)?.[1]
	if (!block) return { name: "", description: "" }
	const field = key => {
		const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)
		return match ? match[1].trim().replace(/^["']/, "").replace(/["']$/, "").trim() : ""
	}
	return { name: field("name"), description: field("description") }
}

/**
 * 从解压后的相对路径里定位技能根。
 * 规则（9.2）：单层根目录自动剥离；多层或直接放根部的，以 SKILL.md 所在目录为技能根。
 * @param {string[]} files 已剥离单层根的相对文件路径
 * @returns {string} 技能根相对路径（根部直放时为空串）
 */
function locateSkillRoot(files) {
	const skillDirs = new Set()
	for (const file of files) {
		if (path.posix.basename(file) !== "SKILL.md") continue
		const dir = path.posix.dirname(file)
		skillDirs.add(dir === "." ? "" : dir)
	}
	if (!skillDirs.size) throw new SkillArchiveError("ARCHIVE_INVALID", "技能包内没有 SKILL.md")
	if (skillDirs.size > 1) throw new SkillArchiveError("ARCHIVE_INVALID", "技能包内有多个技能目录（多个 SKILL.md）")
	return [...skillDirs][0]
}

/**
 * 解析并解压技能包到暂存目录，返回技能根与目录名（尚未落盘到正式位置）。
 * @param {Object} options
 * @param {Buffer} options.buffer zip 内容
 * @param {string} options.skillsRoot <workspace>/.agents/skills
 * @param {string} [options.tempId] 暂存目录后缀，默认随机
 * @returns {Promise<{ dirName: string, skillRoot: string, stagingRoot: string, stagingSkillPath: string, digest: string, bytes: number, files: number, meta: { name: string, description: string } }>}
 */
async function extractArchive(options) {
	const { buffer, skillsRoot, tempId = crypto.randomBytes(6).toString("hex") } = options
	const entries = readZipEntries(buffer)
	// 技能根按 SKILL.md 定位：包内单层容器自然被剥离，同时保住技能目录名
	const skillRoot = locateSkillRoot(entries.filter(entry => !entry.isDirectory).map(entry => entry.name))
	const prefix = skillRoot ? `${skillRoot}/` : ""
	const inside = entries
		.filter(entry => !prefix || entry.name.startsWith(prefix))
		.map(entry => ({ ...entry, relative: prefix ? entry.name.slice(prefix.length) : entry.name }))
		.filter(entry => entry.relative)

	const stagingRoot = path.join(skillsRoot, `${STAGING_PREFIX}${tempId}`)
	await fs.promises.mkdir(stagingRoot, { recursive: true })
	try {
		let bytes = 0
		let files = 0
		for (const entry of inside) {
			if (entry.isDirectory) continue
			const data = readEntryData(buffer, entry)
			// 保留包内层级（含技能根目录本身），commitStaged 只搬技能根子树
			const target = path.join(stagingRoot, ...entry.name.split("/"))
			const relative = path.relative(stagingRoot, target)
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
				throw new SkillArchiveError("ARCHIVE_INVALID", `压缩包内路径越界：${entry.name}`)
			await fs.promises.mkdir(path.dirname(target), { recursive: true })
			await fs.promises.writeFile(target, data)
			bytes += data.length
			files += 1
		}

		const stagingSkillPath = skillRoot ? path.join(stagingRoot, ...skillRoot.split("/")) : stagingRoot

		let skillText
		try {
			skillText = await fs.promises.readFile(path.join(stagingSkillPath, "SKILL.md"), "utf8")
		} catch {
			throw new SkillArchiveError("ARCHIVE_INVALID", "技能包内没有可读的 SKILL.md")
		}
		const meta = parseSkillFrontmatter(skillText)
		if (!meta.name || !meta.description)
			throw new SkillArchiveError("ARCHIVE_INVALID", "SKILL.md 需要包含 name 和 description 元数据")

		// 目录名取包内技能根目录名；根部直放时退回 frontmatter 的 name
		const rawName = skillRoot ? path.posix.basename(skillRoot) : meta.name
		const check = validateDirName(rawName)
		if (!check.ok) throw new SkillArchiveError("ARCHIVE_INVALID", `技能目录名不合法：${rawName}`, { kind: check.kind })
		const digest = await digestDirectory(stagingSkillPath)
		return { dirName: check.dir, skillRoot, stagingRoot, stagingSkillPath, digest, bytes, files, meta }
	} catch (error) {
		await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
		throw error
	}
}

/**
 * 文件夹导入：把源目录复制进暂存目录，复用与 zip 相同的校验与目录名规则。
 * @param {Object} options
 * @param {string} options.sourcePath 用户选择的文件夹
 * @param {string} options.skillsRoot
 * @param {string} [options.tempId]
 * @returns {Promise<{ dirName: string, stagingRoot: string, stagingSkillPath: string, digest: string, bytes: number, files: number, meta: { name: string, description: string } }>}
 */
async function stageFolder(options) {
	const { sourcePath, skillsRoot, tempId = crypto.randomBytes(6).toString("hex") } = options
	let realSource
	try {
		realSource = await fs.promises.realpath(sourcePath)
	} catch {
		throw new SkillArchiveError("ARCHIVE_INVALID", "所选文件夹不存在或不可读")
	}
	if (!(await fs.promises.stat(realSource)).isDirectory()) throw new SkillArchiveError("ARCHIVE_INVALID", "请选择技能文件夹")

	const stagingRoot = path.join(skillsRoot, `${STAGING_PREFIX}${tempId}`)
	await fs.promises.mkdir(stagingRoot, { recursive: true })
	let bytes = 0
	let files = 0
	try {
		/** @param {string} from @param {string} to */
		const copyTree = async (from, to) => {
			const entries = await fs.promises.readdir(from, { withFileTypes: true })
			for (const entry of entries) {
				const source = path.join(from, entry.name)
				const stat = await fs.promises.lstat(source)
				if (stat.isSymbolicLink()) throw new SkillArchiveError("ARCHIVE_INVALID", `技能文件夹不能包含符号链接：${entry.name}`)
				const target = path.join(to, entry.name)
				if (stat.isDirectory()) {
					await fs.promises.mkdir(target, { recursive: true })
					await copyTree(source, target)
					continue
				}
				if (!stat.isFile()) throw new SkillArchiveError("ARCHIVE_INVALID", `技能文件夹包含不支持的文件类型：${entry.name}`)
				if (stat.size > ARCHIVE_LIMITS.maxEntryBytes)
					throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `单个文件超过 ${Math.round(ARCHIVE_LIMITS.maxEntryBytes / 1024 / 1024)}MB 限制：${entry.name}`)
				bytes += stat.size
				if (bytes > ARCHIVE_LIMITS.maxTotalBytes)
					throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `技能文件夹超过 ${Math.round(ARCHIVE_LIMITS.maxTotalBytes / 1024 / 1024)}MB 限制`)
				files += 1
				if (files > ARCHIVE_LIMITS.maxEntries)
					throw new SkillArchiveError("ARCHIVE_TOO_LARGE", `技能文件夹文件数超过 ${ARCHIVE_LIMITS.maxEntries} 个限制`)
				await fs.promises.copyFile(source, target)
			}
		}
		// 源目录本身作为技能根，复制其内容而不是整层目录
		await copyTree(realSource, stagingRoot)

		let skillText
		try {
			skillText = await fs.promises.readFile(path.join(stagingRoot, "SKILL.md"), "utf8")
		} catch {
			throw new SkillArchiveError("ARCHIVE_INVALID", "所选文件夹中没有 SKILL.md")
		}
		const meta = parseSkillFrontmatter(skillText)
		if (!meta.name || !meta.description)
			throw new SkillArchiveError("ARCHIVE_INVALID", "SKILL.md 需要包含 name 和 description 元数据")

		const check = validateDirName(path.basename(realSource))
		if (!check.ok)
			throw new SkillArchiveError("ARCHIVE_INVALID", `文件夹名不能作为技能目录名：${path.basename(realSource)}`, { kind: check.kind })
		const digest = await digestDirectory(stagingRoot)
		return { dirName: check.dir, stagingRoot, stagingSkillPath: stagingRoot, digest, bytes, files, meta }
	} catch (error) {
		await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
		throw error
	}
}

/**
 * 计算目录内容摘要：路径排序后逐个喂 sha256，忽略目录项本身。
 * @param {string} dirPath
 * @returns {Promise<string>} `sha256:<hex>`
 */
async function digestDirectory(dirPath) {
	const hash = crypto.createHash("sha256")
	/** @param {string} current @param {string} relative */
	const walk = async (current, relative) => {
		const entries = await fs.promises.readdir(current, { withFileTypes: true })
		entries.sort((a, b) => a.name.localeCompare(b.name))
		for (const entry of entries) {
			const full = path.join(current, entry.name)
			const rel = relative ? `${relative}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				await walk(full, rel)
				continue
			}
			hash.update(rel.replace(/\\/g, "/"))
			hash.update("\u0000")
			hash.update(await fs.promises.readFile(full))
			hash.update("\u0000")
		}
	}
	await walk(dirPath, "")
	return `sha256:${hash.digest("hex")}`
}

/**
 * 把暂存目录落到正式位置。
 * 覆盖时先把旧目录 rename 成 `.bak`，切换成功再删；任一步失败还原旧目录。
 * @param {Object} options
 * @param {string} options.stagingRoot 暂存根（`.tmp-<id>`）
 * @param {string} options.stagingSkillPath 暂存里的技能目录
 * @param {string} options.skillsRoot
 * @param {string} options.dirName 目标目录名
 * @param {boolean} [options.replace] 允许覆盖同名目录
 * @returns {Promise<{ dir: string, backup: string|null }>}
 */
async function commitStaged(options) {
	const { stagingRoot, stagingSkillPath, skillsRoot, dirName, replace = false } = options
	const target = path.join(skillsRoot, dirName)
	const exists = await fs.promises.lstat(target).then(() => true, () => false)
	if (exists && !replace) throw new SkillArchiveError("DIR_CONFLICT", `技能目录已存在：${dirName}`)

	const backup = `${target}.bak`
	let movedBackup = false
	try {
		if (exists) {
			await fs.promises.rm(backup, { recursive: true, force: true })
			await fs.promises.rename(target, backup)
			movedBackup = true
		}
		// rename 目标若与暂存同盘（都在 .agents/skills 下）是原子切换
		await fs.promises.rename(stagingSkillPath, target)
	} catch (error) {
		if (movedBackup) await fs.promises.rename(backup, target).catch(() => {})
		throw error
	}

	// 暂存根里如果还留着空壳（技能根是子目录时），一并清掉
	await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
	if (movedBackup) await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => {})
	return { dir: dirName, backup: movedBackup ? backup : null }
}

/**
 * 清理暂存目录，失败不抛（清理属尽力而为）。
 * @param {string} stagingRoot
 */
async function discardStaged(stagingRoot) {
	if (!stagingRoot) return
	await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
}

module.exports = {
	ARCHIVE_LIMITS,
	STAGING_PREFIX,
	SkillArchiveError,
	crc32,
	readZipEntries,
	readEntryData,
	singleRootPrefix,
	locateSkillRoot,
	parseSkillFrontmatter,
	extractArchive,
	stageFolder,
	digestDirectory,
	commitStaged,
	discardStaged,
}
