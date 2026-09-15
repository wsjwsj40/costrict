import * as vscode from "vscode"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExecuteCommandTool } from "../ExecuteCommandTool"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getOrCreateTerminal: vi.fn() },
}))
let root: string
let runCommand: ReturnType<typeof vi.fn>
let task: any
let callbacks: any
beforeEach(async () => {
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
	} as any)
	root = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-command-sandbox-"))
	runCommand = vi.fn((_command, callbacks) => {
		callbacks.onShellExecutionComplete({ exitCode: 0 })
		const result: any = Promise.resolve(callbacks.onCompleted("done"))
		result.continue = vi.fn()
		return result
	})
	vi.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue({
		runCommand,
		getCurrentWorkingDirectory: () => root,
	} as any)
	task = {
		cwd: root,
		taskId: "sandbox-test",
		lastMessageTs: 1,
		say: vi.fn().mockResolvedValue(undefined),
		providerRef: {
			deref: () => ({
				context: { extensionPath: "/extension" },
				getState: async () => ({
					terminalSandboxEnabled: true,
					terminalShellIntegrationDisabled: false,
				}),
				postMessageToWebview: vi.fn(),
			}),
		},
	}
	callbacks = { askApproval: vi.fn().mockResolvedValue(true), handleError: vi.fn(), pushToolResult: vi.fn() }
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
	vi.clearAllMocks()
})
it("routes sandbox commands to the isolated runner even when VS Code integration is enabled", async () => {
	await new ExecuteCommandTool().execute({ command: "pnpm test" }, task, callbacks)
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.askApproval).toHaveBeenCalledWith(
		"command",
		"pnpm test",
		undefined,
		undefined,
		expect.objectContaining({ cwd: await fs.realpath(root), sandbox: "workspace" }),
	)
	expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(await fs.realpath(root), "sandbox-test", "execa")
	const launch = runCommand.mock.calls[0][2]
	expect(JSON.parse(launch.input).command).toBe("pnpm test")
})
it("never launches when escalation has no reason or the user refuses", async () => {
	await new ExecuteCommandTool().execute(
		{ command: "pnpm test", sandbox_permissions: "require_escalated" },
		task,
		callbacks,
	)
	expect(runCommand).not.toHaveBeenCalled()
	expect(callbacks.askApproval).not.toHaveBeenCalled()
	callbacks.askApproval.mockResolvedValue(false)
	await new ExecuteCommandTool().execute(
		{ command: "pnpm test", sandbox_permissions: "require_escalated", justification: "Need host service" },
		task,
		callbacks,
	)
	expect(callbacks.askApproval).toHaveBeenCalledWith(
		"command",
		"pnpm test",
		undefined,
		undefined,
		expect.objectContaining({ sandbox: "outside", reason: "Need host service" }),
	)
	expect(runCommand).not.toHaveBeenCalled()
})
it("rejects outside working directories before requesting execution", async () => {
	await new ExecuteCommandTool().execute({ command: "pwd", cwd: os.tmpdir() }, task, callbacks)
	expect(runCommand).not.toHaveBeenCalled()
	expect(callbacks.askApproval).not.toHaveBeenCalled()
})
