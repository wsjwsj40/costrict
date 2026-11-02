const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn } = require("node:child_process")
const { Readable, Transform } = require("node:stream")
const { pipeline } = require("node:stream/promises")

const targets = {
	"linux/x64": { triple: "x86_64-unknown-linux-musl", executable: "codex" },
	"linux/arm64": { triple: "aarch64-unknown-linux-musl", executable: "codex" },
	"win32/x64": { triple: "x86_64-pc-windows-msvc", executable: "codex.exe" },
	"win32/arm64": { triple: "aarch64-pc-windows-msvc", executable: "codex.exe" },
}
const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
		let stderr = ""
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk).slice(0, 2048)
		})
		child.on("error", reject)
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 512)}`)),
		)
	})
}

async function downloadArchive(url, target, expectedHash, onProgress) {
	const response = await fetch(url, { signal: AbortSignal.timeout(600000), redirect: "error" })
	if (!response.ok || !response.body) throw new Error(`Codex 下载失败：HTTP ${response.status}`)
	const total = Number(response.headers.get("content-length")) || 0
	if (total > MAX_ARCHIVE_BYTES) throw new Error("Codex 安装包过大")
	const hash = crypto.createHash("sha256")
	let bytes = 0
	const meter = new Transform({
		transform(chunk, _encoding, done) {
			bytes += chunk.length
			if (bytes > MAX_ARCHIVE_BYTES) return done(new Error("Codex 安装包过大"))
			hash.update(chunk)
			onProgress?.(total ? Math.min(99, Math.floor((bytes * 100) / total)) : null)
			done(null, chunk)
		},
	})
	await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target, { flags: "wx" }))
	if (hash.digest("hex") !== expectedHash.toLowerCase()) throw new Error("Codex 安装包 SHA-256 校验失败")
}

async function ensureCodexInstalled(baseUrl, storagePath, onProgress) {
	const target = targets[`${process.platform}/${process.arch}`]
	if (!target) throw new Error(`不支持的 Codex 平台：${process.platform}/${process.arch}`)
	const url = `${baseUrl.replace(/\/$/, "")}/costrict/codex/${process.platform}/${process.arch}/manifest.json`
	let manifest
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store" })
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		manifest = await response.json()
	} catch (error) {
		throw new Error(`无法获取集群中的 Codex 安装清单：${error.message}`)
	}
	if (
		!/^\d+\.\d+\.\d+$/.test(manifest.version) ||
		!/^[a-f0-9]{64}$/i.test(manifest.sha256) ||
		!/^codex-[a-zA-Z0-9._-]+\.tgz$/.test(manifest.archive)
	) {
		throw new Error("Codex 安装清单格式无效")
	}
	const installDir = path.join(storagePath, "codex", `${manifest.version}-${manifest.sha256.slice(0, 12)}`)
	const executable = path.join(installDir, "package", "vendor", target.triple, "bin", target.executable)
	if (fs.existsSync(executable)) return executable

	await fs.promises.mkdir(path.dirname(installDir), { recursive: true })
	const tempDir = `${installDir}-${crypto.randomUUID()}.tmp`
	const archivePath = path.join(tempDir, manifest.archive)
	try {
		await fs.promises.mkdir(tempDir, { recursive: true })
		onProgress?.(0)
		await downloadArchive(new URL(manifest.archive, url).toString(), archivePath, manifest.sha256, onProgress)
		await run("tar", ["-xzf", archivePath, "-C", tempDir])
		const tempExecutable = path.join(tempDir, "package", "vendor", target.triple, "bin", target.executable)
		if (!fs.existsSync(tempExecutable)) throw new Error("Codex 安装包缺少可执行文件")
		if (process.platform !== "win32") await fs.promises.chmod(tempExecutable, 0o755)
		await fs.promises.rm(archivePath)
		try {
			await fs.promises.rename(tempDir, installDir)
		} catch (error) {
			if (!fs.existsSync(executable)) throw error
		}
		onProgress?.(100)
		return executable
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
	}
}

module.exports = { ensureCodexInstalled }
