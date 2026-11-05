const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn } = require("node:child_process")
const { isInstalled, publishInstall, downloadArchive, run } = require("./codexInstaller")

function powerShellEnv(executable, source = process.env) {
	const env = { ...source }
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH"
	env[pathKey] = `${path.dirname(executable)}${path.delimiter}${env[pathKey] || ""}`
	return env
}

function probePowerShell(executable) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "if ($PSVersionTable.PSVersion.Major -ne 7) { exit 1 }"], {
			windowsHide: true, stdio: "ignore", timeout: 20000,
		})
		child.on("error", reject)
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`PowerShell 7 启动检查失败：${code}`)))
	})
}

async function ensurePowerShellInstalled(baseUrl, storagePath, onProgress, options = {}) {
	const platform = options.platform || process.platform
	const arch = options.arch || process.arch
	if (platform !== "win32" || !["x64", "arm64"].includes(arch)) throw new Error(`不支持的 PowerShell 平台：${platform}/${arch}`)
	const url = `${baseUrl.replace(/\/$/, "")}/costrict/powershell/win32/${arch}/manifest.json`
	let manifest
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store" })
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		manifest = await response.json()
	} catch (error) {
		throw new Error(`无法获取集群中的 PowerShell 7 安装清单：${error.message}`)
	}
	if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{64}$/i.test(manifest.sha256) ||
		!/^powershell-[a-zA-Z0-9._-]+\.tgz$/.test(manifest.archive)) throw new Error("PowerShell 7 安装清单格式无效")
	const installDir = path.join(storagePath, "powershell", `${manifest.version}-${manifest.sha256.slice(0, 12)}`)
	const executable = path.join(installDir, "package", "pwsh.exe")
	const marker = path.join(installDir, ".installed")
	if (isInstalled(executable, marker, manifest.sha256)) {
		await (options.probe || probePowerShell)(executable)
		return executable
	}
	await fs.promises.mkdir(path.dirname(installDir), { recursive: true })
	const tempDir = `${installDir}-${crypto.randomUUID()}.tmp`
	const archivePath = path.join(tempDir, manifest.archive)
	try {
		await fs.promises.mkdir(tempDir, { recursive: true })
		onProgress?.(0)
		await downloadArchive(new URL(manifest.archive, url).toString(), archivePath, manifest.sha256, onProgress, "PowerShell 7")
		const entries = require("node:child_process").execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim().split(/\r?\n/)
		if (entries.some((entry) => !/^package\/(?!\.\.\/)(?:[^/]+\/?)*$/.test(entry) || entry.split("/").includes("..") || entry.includes("\\"))) throw new Error("PowerShell 7 安装包包含无效路径")
		await run("tar", ["-xzf", archivePath, "-C", tempDir])
		const tempExecutable = path.join(tempDir, "package", "pwsh.exe")
		if (!fs.existsSync(tempExecutable)) throw new Error("PowerShell 7 安装包缺少 pwsh.exe")
		await (options.probe || probePowerShell)(tempExecutable)
		await fs.promises.rm(archivePath)
		await publishInstall(tempDir, installDir, executable, manifest.sha256)
		if (!isInstalled(executable, marker, manifest.sha256)) throw new Error("PowerShell 7 安装文件未完整写入")
		onProgress?.(100)
		return executable
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
	}
}

module.exports = { ensurePowerShellInstalled, powerShellEnv }
