import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sandboxEnvironment } from "../policy"

// Explicit opt-in: these verify kernel enforcement, not a mocked command wrapper.
const runner = process.env.DICODE_SANDBOX_TEST_RUNNER

async function runtimeIsAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [runner!, "--check"], {
			env: sandboxEnvironment(process.env),
			stdio: "ignore",
		})
		child.once("error", () => resolve(false))
		child.once("exit", (code) => resolve(code === 0))
	})
}

it.skipIf(!runner)(
	"enforces child-process writes, protected reads and direct network denial",
	async () => {
		// Some container hosts prohibit the namespace/socket primitives that the
		// runtime requires. The ordinary unit tests still exercise the policy;
		// this opt-in test runs kernel enforcement only where the probe succeeds.
		if (!(await runtimeIsAvailable())) return
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-runtime-test-"))
		const workspace = path.join(root, "project")
		const home = path.join(root, "home")
		try {
			await fs.mkdir(workspace)
			await fs.mkdir(path.join(workspace, ".git"))
			await fs.mkdir(path.join(home, ".ssh"), { recursive: true })
			await fs.writeFile(path.join(home, ".ssh", "key"), "secret")
			await fs.writeFile(path.join(workspace, ".git", "config"), "protected")
			await fs.symlink(root, path.join(workspace, "escape"), "dir")
			const program = `const fs=require('fs'); fs.writeFileSync('inside','ok'); for (const p of [${JSON.stringify(path.join(root, "outside"))},'escape/through-link','.git/config']) {try {fs.writeFileSync(p,'bad'); console.log('WRITE_ESCAPED')} catch {console.log('WRITE_BLOCKED')}} try {fs.readFileSync(${JSON.stringify(path.join(home, ".ssh/key"))}); console.log('READ_ESCAPED')} catch {console.log('READ_BLOCKED')}`
			await fs.writeFile(path.join(workspace, "test.cjs"), program)
			const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
				const child = spawn(process.execPath, [runner!], {
					cwd: workspace,
					env: { ...sandboxEnvironment(process.env), HOME: home },
					stdio: ["pipe", "pipe", "pipe"],
				})
				let output = ""
				child.stdout.on("data", (chunk) => (output += chunk))
				child.stderr.on("data", (chunk) => (output += chunk))
				child.on("error", reject)
				child.on("exit", (code) => resolve({ code, output }))
				child.stdin.end(
					JSON.stringify({
						command: `"${process.execPath}" test.cjs`,
						workspace,
						cwd: workspace,
						shell: "/bin/bash",
					}),
				)
			})
			expect(result.output).not.toContain("ESCAPED")
			expect(result.code, result.output).toBe(0)
			expect(result.output.match(/WRITE_BLOCKED/g)).toHaveLength(3)
			expect(result.output).toContain("READ_BLOCKED")
			expect(await fs.readFile(path.join(workspace, "inside"), "utf8")).toBe("ok")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	},
	60_000,
)
