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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-command-policy-"))
	runCommand = vi.fn((_command, terminalCallbacks) => {
		terminalCallbacks.onShellExecutionComplete({ exitCode: 0 })
		const result: any = Promise.resolve(terminalCallbacks.onCompleted("done"))
		result.continue = vi.fn()
		return result
	})
	vi.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue({
		runCommand,
		getCurrentWorkingDirectory: () => root,
	} as any)
	task = {
		cwd: root,
		taskId: "policy-test",
		lastMessageTs: 1,
		say: vi.fn().mockResolvedValue(undefined),
		providerRef: {
			deref: () => ({
				getState: async () => ({ terminalShellIntegrationDisabled: true }),
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

it("runs ordinary commands directly after project authorization", async () => {
	await new ExecuteCommandTool().execute({ command: "python3 --version" }, task, callbacks)
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.askApproval).toHaveBeenCalledWith(
		"command",
		"python3 --version",
		undefined,
		undefined,
		expect.objectContaining({ scope: "workspace" }),
	)
	expect(TerminalRegistry.getOrCreateTerminal).toHaveBeenCalledWith(await fs.realpath(root), "policy-test", "execa")
	expect(runCommand).toHaveBeenCalledWith("python3 --version", expect.any(Object))
})

it("classifies a working directory outside the project for one-time approval", async () => {
	await new ExecuteCommandTool().execute({ command: "pwd", cwd: os.tmpdir() }, task, callbacks)
	expect(callbacks.askApproval).toHaveBeenCalledWith(
		"command",
		"pwd",
		undefined,
		undefined,
		expect.objectContaining({ scope: "outside" }),
	)
	expect(runCommand).toHaveBeenCalled()
})

it("keeps destructive commands marked for review", async () => {
	await new ExecuteCommandTool().execute({ command: "rm file" }, task, callbacks)
	expect(callbacks.askApproval).toHaveBeenCalledWith(
		"command",
		"rm file",
		undefined,
		undefined,
		expect.objectContaining({ requiresReview: true }),
	)
})
