// Package the reviewed official platform npm archives for the existing portal static route.
// Usage: node scripts/package-dicode-codex-cli.js VERSION LINUX_X64 WINDOWS_X64 LINUX_ARM64 WINDOWS_ARM64 OUTPUT_TAR
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")

const [version, linuxX64Archive, windowsX64Archive, linuxArm64Archive, windowsArm64Archive, outputTar] =
	process.argv.slice(2)
if (
	!/^\d+\.\d+\.\d+$/.test(version) ||
	!linuxX64Archive ||
	!windowsX64Archive ||
	!linuxArm64Archive ||
	!windowsArm64Archive ||
	!outputTar
) {
	throw new Error(
		"usage: node scripts/package-dicode-codex-cli.js VERSION LINUX_X64 WINDOWS_X64 LINUX_ARM64 WINDOWS_ARM64 OUTPUT_TAR",
	)
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dicode-codex-cli-"))
try {
	for (const [platform, arch, archive] of [
		["linux", "x64", linuxX64Archive],
		["win32", "x64", windowsX64Archive],
		["linux", "arm64", linuxArm64Archive],
		["win32", "arm64", windowsArm64Archive],
	]) {
		const packageJSON = JSON.parse(
			execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
		)
		if (
			packageJSON.name !== "@openai/codex" ||
			packageJSON.version !== `${version}-${platform}-${arch}` ||
			packageJSON.os?.[0] !== platform ||
			packageJSON.cpu?.[0] !== arch
		) {
			throw new Error(`wrong Codex platform package: ${archive}`)
		}
		const dir = path.join(stage, platform, arch)
		fs.mkdirSync(dir, { recursive: true })
		const filename = `codex-${version}-${platform}-${arch}.tgz`
		const destination = path.join(dir, filename)
		fs.copyFileSync(archive, destination)
		const checksum = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex")
		fs.writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({ version, archive: filename, sha256: checksum }, null, 2) + "\n",
		)
	}
	fs.mkdirSync(path.dirname(outputTar), { recursive: true })
	execFileSync("tar", ["-cf", outputTar, "-C", stage, "."])
	console.log(`packaged Codex ${version} Linux and Windows x64/arm64 assets: ${outputTar}`)
} finally {
	fs.rmSync(stage, { recursive: true, force: true })
}
