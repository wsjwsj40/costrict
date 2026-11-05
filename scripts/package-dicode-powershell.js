// Usage: node scripts/package-dicode-powershell.js X64_ZIP ARM64_ZIP OUTPUT_TAR
// Inputs must be the official PowerShell 7.6.6 portable ZIP assets.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")

const version = "7.6.6"
const inputs = [
	{ arch: "x64", file: process.argv[2], checksum: "02FE458BE20493FBDF43F61EA20610B811EE6C738AB1676C61B9CFCD1A33C860" },
	{ arch: "arm64", file: process.argv[3], checksum: "BBDE9DDA31D148415ECCB5FBE1638E6400A144187B006E5B3FD8EC2F39D781BE" },
]
const output = process.argv[4]
if (inputs.some((input) => !input.file) || !output) throw new Error("usage: node scripts/package-dicode-powershell.js X64_ZIP ARM64_ZIP OUTPUT_TAR")
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dicode-powershell-"))
try {
	for (const { arch, file, checksum } of inputs) {
		const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
		if (actual.toLowerCase() !== checksum.toLowerCase()) throw new Error(`official PowerShell ${arch} ZIP checksum mismatch`)
		const dir = path.join(stage, "win32", arch)
		const packageDir = path.join(stage, `unpacked-${arch}`, "package")
		fs.mkdirSync(dir, { recursive: true })
		fs.mkdirSync(packageDir, { recursive: true })
		execFileSync("unzip", ["-q", file, "-d", packageDir])
		if (!fs.existsSync(path.join(packageDir, "pwsh.exe"))) throw new Error(`PowerShell ${arch} ZIP lacks pwsh.exe`)
		const archive = `powershell-${version}-win32-${arch}.tgz`
		execFileSync("tar", ["-czf", path.join(dir, archive), "-C", path.dirname(packageDir), "package"])
		const sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, archive))).digest("hex")
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version, archive, sha256 }, null, 2) + "\n")
	}
	fs.mkdirSync(path.dirname(output), { recursive: true })
	execFileSync("tar", ["-cf", output, "-C", stage, "win32"])
	console.log(`packaged PowerShell ${version}: ${output}`)
} finally {
	fs.rmSync(stage, { recursive: true, force: true })
}
