import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { sandboxEnvironment } from "./policy"

export interface SandboxLaunch {
	file: string
	args: string[]
	input: string
	env: NodeJS.ProcessEnv
}

export function sandboxRunnerPath(extensionPath: string): string {
	return path.join(extensionPath, "dist", "sandbox", "runtime", "runner.mjs")
}

export async function checkSandbox(extensionPath: string): Promise<{ available: boolean; detail: string }> {
	try {
		const runner = sandboxRunnerPath(extensionPath)
		await fs.access(runner)
		const { stdout } = await promisify(execFile)(process.execPath, [runner, "--check"], {
			env: { ...sandboxEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" },
			timeout: 30_000,
			maxBuffer: 64_000,
		})
		const result = JSON.parse(stdout)
		return { available: result.available === true, detail: (result.warnings || []).join("\n") }
	} catch (error) {
		const failure = error as Error & { stderr?: string }
		return {
			available: false,
			detail: [failure.message, failure.stderr].filter(Boolean).join("\n"),
		}
	}
}

export function createSandboxLaunch(
	extensionPath: string,
	request: { command: string; cwd: string; workspace: string; shell: string },
): SandboxLaunch {
	return {
		file: process.execPath,
		args: [sandboxRunnerPath(extensionPath)],
		input: JSON.stringify(request),
		env: { ...sandboxEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" },
	}
}
