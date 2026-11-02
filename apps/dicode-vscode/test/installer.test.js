const test = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { ensureCodexInstalled } = require("../codexInstaller")

test(
	"downloads, verifies, installs and reuses a Codex platform package",
	{ skip: process.platform !== "linux" || process.arch !== "x64" },
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dicode-installer-test-"))
		const archiveName = "codex-0.164.0-linux-x64.tgz"
		const archive = path.join(root, archiveName)
		const binary = path.join(root, "package/vendor/x86_64-unknown-linux-musl/bin/codex")
		fs.mkdirSync(path.dirname(binary), { recursive: true })
		fs.writeFileSync(binary, "#!/bin/sh\necho codex-test\n")
		execFileSync("tar", ["-czf", archive, "-C", root, "package"])
		const content = fs.readFileSync(archive)
		const sha256 = crypto.createHash("sha256").update(content).digest("hex")
		let downloads = 0
		const server = http.createServer((request, response) => {
			if (request.url.endsWith("manifest.json")) {
				response.setHeader("Content-Type", "application/json")
				response.end(JSON.stringify({ version: "0.164.0", archive: archiveName, sha256 }))
			} else {
				downloads++
				response.setHeader("Content-Length", content.length)
				response.end(content)
			}
		})
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
		try {
			const base = `http://127.0.0.1:${server.address().port}`
			const installed = await ensureCodexInstalled(base, path.join(root, "storage"))
			assert.equal(fs.readFileSync(installed, "utf8"), "#!/bin/sh\necho codex-test\n")
			assert.equal(await ensureCodexInstalled(base, path.join(root, "storage")), installed)
			assert.equal(downloads, 1)
		} finally {
			server.close()
			fs.rmSync(root, { recursive: true, force: true })
		}
	},
)
