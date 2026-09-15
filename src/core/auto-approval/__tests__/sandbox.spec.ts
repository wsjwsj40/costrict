import { checkAutoApproval } from "../index"
const state = { autoApprovalEnabled: true, alwaysAllowExecute: true, allowedCommands: [], deniedCommands: [] }
const context = { cwd: "/project", sandbox: "workspace" as const }
it.each([
	"ls",
	"rg --files",
	"git status",
	"git diff",
	"git log -1",
	"pnpm test",
	"CI=1 pnpm test",
	"python script.py",
	"node -e 'console.log(1)'",
])("runs %s inside the sandbox without a wildcard", async (text) => {
	expect(await checkAutoApproval({ state, ask: "command", text, commandExecution: context })).toEqual({
		decision: "approve",
	})
})
it("requires explicit approval outside the sandbox even with *", async () => {
	expect(
		await checkAutoApproval({
			state: { ...state, allowedCommands: ["*"] },
			ask: "command",
			text: "pnpm test",
			commandExecution: { ...context, sandbox: "outside" },
		}),
	).toEqual({ decision: "ask" })
})
it("preserves destructive review, denials and the master switch", async () => {
	expect(
		await checkAutoApproval({
			state,
			ask: "command",
			text: "rm file",
			commandExecution: { ...context, requiresReview: true },
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state: { ...state, deniedCommands: ["pnpm"] },
			ask: "command",
			text: "pnpm test",
			commandExecution: context,
		}),
	).toEqual({ decision: "deny" })
	expect(
		await checkAutoApproval({
			state: { ...state, autoApprovalEnabled: false },
			ask: "command",
			text: "pnpm test",
			commandExecution: context,
		}),
	).toEqual({ decision: "ask" })
})
it("does not broaden legacy allowlist permissions when sandboxing is off", async () => {
	expect(await checkAutoApproval({ state, ask: "command", text: "pnpm test" })).toEqual({ decision: "ask" })
})

it("uses a project profile instead of the legacy global execution switch", async () => {
	const projectState = {
		...state,
		autoApprovalEnabled: false,
		alwaysAllowExecute: false,
		projectPermissionProfile: { mode: "sandbox-development" as const, updatedAt: 1 },
	}
	expect(
		await checkAutoApproval({ state: projectState, ask: "command", text: "pnpm test", commandExecution: context }),
	).toEqual({
		decision: "approve",
	})
	expect(
		await checkAutoApproval({
			state: {
				...projectState,
				projectPermissionProfile: { ...projectState.projectPermissionProfile, mode: "observe" as const },
			},
			ask: "command",
			text: "pnpm test",
			commandExecution: context,
		}),
	).toEqual({ decision: "ask" })
})

it("enforces project modes for file writes even when the legacy write toggle is enabled", async () => {
	const write = JSON.stringify({ tool: "newFileCreated", path: "src/example.ts" })
	const legacyWriteEnabled = { ...state, alwaysAllowWrite: true }
	expect(
		await checkAutoApproval({
			state: { ...legacyWriteEnabled, projectPermissionProfile: { mode: "observe", updatedAt: 1 } },
			ask: "tool",
			text: write,
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state: { ...legacyWriteEnabled, projectPermissionProfile: { mode: "sandbox-development", updatedAt: 1 } },
			ask: "tool",
			text: write,
		}),
	).toEqual({ decision: "approve" })
	expect(
		await checkAutoApproval({
			state: { ...legacyWriteEnabled, projectPermissionProfile: { mode: "sandbox-development", updatedAt: 1 } },
			ask: "tool",
			text: JSON.stringify({ tool: "newFileCreated", path: "../outside.ts", isOutsideWorkspace: true }),
		}),
	).toEqual({ decision: "ask" })
})
