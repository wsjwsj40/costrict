import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { parseCommand } from "../../shared/parse-command"

export function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

// Do not inherit credentials, loader hooks, proxy settings or shell startup hooks.
export function sandboxEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const names = [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"SystemRoot",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"USERPROFILE",
		"LOCALAPPDATA",
		"APPDATA",
		"TEMP",
		"TMP",
		"TMPDIR",
		"JAVA_HOME",
		"GOPATH",
		"GOROOT",
		"DOTNET_ROOT",
	]
	const env: NodeJS.ProcessEnv = {}
	for (const name of names) if (source[name]) env[name] = source[name]
	return { ...env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", PYTHONIOENCODING: "utf-8" }
}

export async function createSandboxPolicy(
	workspace: string,
	cwd: string,
	tempDir: string,
): Promise<SandboxRuntimeConfig> {
	const root = await fs.realpath(workspace)
	const directory = await fs.realpath(cwd)
	if (!isWithin(root, directory)) throw new Error("The command working directory is outside the sandbox workspace.")
	if (root === path.parse(root).root || root === (await fs.realpath(os.homedir())))
		throw new Error(
			"Open a project folder instead of the filesystem root or home directory before enabling the sandbox.",
		)
	const home = os.homedir()
	const secrets = [
		".ssh",
		".aws",
		".azure",
		".kube",
		".gnupg",
		".docker",
		".config",
		".codex",
		".claude",
		".dicode",
		".roo",
		".npmrc",
		".netrc",
		".git-credentials",
	].map((name) => path.join(home, name))
	const protectedPaths = [
		".git",
		".vscode",
		".idea",
		".roo",
		".dicode",
		".codex",
		".agents",
		".claude",
		".rooignore",
		"AGENTS.md",
	].map((name) => path.join(root, name))
	// The upstream runtime permits a few diagnostic locations by default. They
	// are not needed by this extension and would fall outside this command's
	// workspace and private temporary directory.
	const runtimeDiagnosticPaths = [
		path.join(os.tmpdir(), "claude"),
		path.join(home, ".npm", "_logs"),
		path.join(home, ".claude", "debug"),
	]
	const envFiles = (await fs.readdir(root))
		.filter((name) => name === ".env" || name.startsWith(".env."))
		.map((name) => path.join(root, name))
	return {
		filesystem: {
			denyRead: [...secrets, ...envFiles],
			allowWrite: [root, tempDir],
			denyWrite: [...protectedPaths, ...secrets, ...envFiles, ...runtimeDiagnosticPaths],
		},
		// DiCode is primarily used on intranets. The sandbox limits filesystem and
		// process boundaries; it does not maintain a network-domain allowlist.
		network: { allowedDomains: ["*"], deniedDomains: [], allowLocalBinding: false },
		enableWeakerNestedSandbox: false,
		enableWeakerNetworkIsolation: false,
		allowAppleEvents: false,
	}
}

/** Additional UX guard, not a substitute for OS isolation or backups. */
export function needsDestructiveReview(command: string): boolean {
	return parseCommand(command).some((segment) => {
		const normalized = segment.replace(/["']/g, "").toLowerCase()
		return (
			/(?:^|\s)(?:[^\s]*[/\\])?(?:rm|rmdir|unlink|shred|del|erase|rd|remove-item|sudo|doas|su)(?:\.exe)?(?:\s|$)/.test(
				normalized,
			) ||
			/\bgit\s+(?:reset|clean|restore|checkout|rebase)\b/.test(normalized) ||
			/\bgit\s+push\b.*(?:--force|-f\b|--delete|--mirror)/.test(normalized)
		)
	})
}
