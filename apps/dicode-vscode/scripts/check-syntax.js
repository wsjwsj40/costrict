/**
 * 语法检查：递归检查扩展侧全部 .js（含 media/ 与 test/）。
 *
 * 之所以不用 `node --check *.js`：npm 脚本在 Windows 上走 cmd.exe，通配符不会展开，
 * 而 node --check 只接受单个文件。这里用 Node 自己遍历，保持跨平台一致。
 * 新增 .js 模块会自动纳入检查，不再需要手工往 check 脚本里加文件名。
 */

const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

/** 不需要检查的目录（构建产物、依赖、测试缓存） */
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "coverage", ".vscode-test", ".git"])
const EXTENSIONS = new Set([".js", ".cjs", ".mjs"])

/** @param {string} dir @returns {string[]} */
function collect(dir) {
	/** @type {string[]} */
	const files = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue
			files.push(...collect(path.join(dir, entry.name)))
			continue
		}
		if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(path.join(dir, entry.name))
	}
	return files
}

const root = path.resolve(__dirname, "..")
const files = collect(root).sort()
let failed = 0
for (const file of files) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })
	} catch (error) {
		failed++
		const output = error.stderr?.toString().trim() || error.message
		console.error(`✗ ${path.relative(root, file)}\n${output}\n`)
	}
}
console.log(`语法检查：${files.length} 个文件，${failed} 个失败`)
if (failed > 0) process.exitCode = 1
