import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSandboxPolicy, isWithin, needsDestructiveReview, sandboxEnvironment } from "../policy"
import { createSandboxLaunch } from "../index"

let directory: string
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-policy-test-"))
})
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true })
})

it("binds writes to canonical workspace paths and rejects symlink escapes", async () => {
	const workspace = path.join(directory, "workspace")
	const outside = path.join(directory, "outside")
	await fs.mkdir(workspace)
	await fs.mkdir(outside)
	await fs.writeFile(path.join(workspace, ".env.local"), "secret")
	await fs.symlink(outside, path.join(workspace, "link"), "dir")
	const policy = await createSandboxPolicy(workspace, workspace, path.join(directory, "tmp"))
	expect(policy.filesystem.allowWrite).toEqual([await fs.realpath(workspace), path.join(directory, "tmp")])
	expect(policy.filesystem.denyWrite).toContain(path.join(workspace, ".git"))
	expect(policy.filesystem.denyRead).toContain(path.join(workspace, ".env.local"))
	expect(policy.network.allowedDomains).toEqual(["*"])
	await expect(createSandboxPolicy(workspace, path.join(workspace, "link"), directory)).rejects.toThrow("outside")
	expect(isWithin(workspace, workspace + "-other")).toBe(false)
})

it("does not inherit tokens or execution hooks", () => {
	const env = sandboxEnvironment({
		PATH: "/usr/bin",
		HOME: "/home/example",
		OPENAI_API_KEY: "secret",
		NODE_OPTIONS: "--require evil",
		BASH_ENV: "evil",
		LD_PRELOAD: "evil",
		HTTPS_PROXY: "http://evil",
		SSH_AUTH_SOCK: "socket",
	})
	expect(env.PATH).toBe("/usr/bin")
	for (const key of ["OPENAI_API_KEY", "NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD", "HTTPS_PROXY", "SSH_AUTH_SOCK"])
		expect(env[key]).toBeUndefined()
})

it("passes the command as JSON input, never host-shell syntax", () => {
	const command = 'echo "$(touch should-not-run)"; rm file'
	const launch = createSandboxLaunch(directory, {
		command,
		cwd: directory,
		workspace: directory,
		shell: "/bin/bash",
	})
	expect(launch.args).toHaveLength(1)
	expect(launch.args.join(" ")).not.toContain(command)
	expect(JSON.parse(launch.input).command).toBe(command)
})

it.each([
	"rm -rf dist",
	"sudo apt install x",
	"git reset --hard",
	"git push --force",
	'bash -c "rm file"',
	"/bin/rm file",
])("keeps destructive review for %s", (command) => {
	expect(needsDestructiveReview(command)).toBe(true)
})
it.each(["pnpm test", "python script.py", "node -e 'console.log(1)'", "CI=1 pnpm test", "git status"])(
	"does not blanket-block scripts: %s",
	(command) => {
		expect(needsDestructiveReview(command)).toBe(false)
	},
)
