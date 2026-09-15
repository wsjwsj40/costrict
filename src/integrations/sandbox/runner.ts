// Bundled as a separate Node process: SandboxManager is a singleton, so each
// invocation owns its policy, proxies and lifetime (including background work).
import { SandboxManager, installWindowsSandboxAsync } from "@anthropic-ai/sandbox-runtime"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSandboxPolicy, sandboxEnvironment } from "./policy"

async function main() {
	if (process.argv.includes("--install-windows")) {
		if (process.platform !== "win32") throw new Error("Windows setup is only available on Windows.")
		await installWindowsSandboxAsync()
		return
	}
	const dependencies = await SandboxManager.checkDependenciesAsync()
	if (!SandboxManager.isSupportedPlatform() || dependencies.errors.length)
		throw new Error(dependencies.errors.join("\n") || "Unsupported platform")
	if (process.argv.includes("--check")) {
		const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-sandbox-check-"))
		const probeWorkspace = path.join(probeRoot, "workspace")
		try {
			await fs.mkdir(probeWorkspace)
			await SandboxManager.initialize(await createSandboxPolicy(probeWorkspace, probeWorkspace, probeRoot))
			if (!SandboxManager.isSandboxingEnabled()) throw new Error("Sandbox enforcement did not initialize")
			process.stdout.write(JSON.stringify({ available: true, warnings: dependencies.warnings }))
		} finally {
			await SandboxManager.reset()
			await fs.rm(probeRoot, { recursive: true, force: true })
		}
		return
	}
	let input = ""
	for await (const chunk of process.stdin) {
		input += chunk
		if (input.length > 1_000_000) throw new Error("Sandbox request is too large")
	}
	const request = JSON.parse(input) as {
		command: string
		workspace: string
		cwd: string
		shell: string
	}
	if (!request.command || !request.workspace || !request.cwd) throw new Error("Invalid sandbox request")
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-sandbox-"))
	let child: ReturnType<typeof spawn> | undefined
	try {
		const config = await createSandboxPolicy(request.workspace, request.cwd, tempDir)
		process.chdir(await fs.realpath(request.cwd))
		await SandboxManager.initialize(config)
		if (!SandboxManager.isSandboxingEnabled()) throw new Error("Sandbox enforcement did not initialize")
		const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
			request.command,
			request.shell,
			undefined,
			undefined,
			process.cwd(),
		)
		child = spawn(argv[0], argv.slice(1), {
			shell: false,
			stdio: ["ignore", "inherit", "inherit"],
			env: {
				...sandboxEnvironment(process.env),
				...env,
				TMPDIR: tempDir,
				XDG_CACHE_HOME: path.join(tempDir, "cache"),
				npm_config_cache: path.join(tempDir, "npm"),
				GIT_OPTIONAL_LOCKS: "0",
			},
		})
		const stop = () => child?.kill("SIGTERM")
		process.once("SIGTERM", stop)
		process.once("SIGINT", stop)
		const code = await new Promise<number>((resolve, reject) => {
			child!.once("error", reject)
			child!.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
		})
		process.removeListener("SIGTERM", stop)
		process.removeListener("SIGINT", stop)
		process.exitCode = code
	} finally {
		await SandboxManager.reset()
		await fs.rm(tempDir, { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(
		`[DiCode sandbox] ${error instanceof Error ? error.message : String(error)}\nThe command was not retried outside the sandbox. Request explicit outside-sandbox approval if necessary.`,
	)
	process.exitCode = 125
})
