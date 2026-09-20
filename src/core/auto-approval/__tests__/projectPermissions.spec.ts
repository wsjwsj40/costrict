import { checkAutoApproval } from "../index"

const workspaceCommand = { cwd: "/project", scope: "workspace" as const }
const request = {
	autoApprovalEnabled: true,
	projectPermissionProfile: { mode: "request-approval" as const, updatedAt: 1 },
}
const automatic = { ...request, projectPermissionProfile: { mode: "auto-approval" as const, updatedAt: 1 } }

it("approves project reads in both permission modes but asks for request-mode commands", async () => {
	expect(
		await checkAutoApproval({
			state: request,
			ask: "command",
			text: "pnpm test",
			commandExecution: workspaceCommand,
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state: request,
			ask: "tool",
			text: JSON.stringify({ tool: "readFile", path: "src/example.ts" }),
		}),
	).toEqual({ decision: "approve" })
})

it("auto-approves ordinary project commands only in auto approval", async () => {
	expect(
		await checkAutoApproval({
			state: automatic,
			ask: "command",
			text: "pnpm test",
			commandExecution: workspaceCommand,
		}),
	).toEqual({ decision: "approve" })
	expect(
		await checkAutoApproval({
			state: automatic,
			ask: "command",
			text: "pnpm test",
			commandExecution: { ...workspaceCommand, scope: "outside" },
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state: automatic,
			ask: "command",
			text: "rm file",
			commandExecution: { ...workspaceCommand, requiresReview: true },
		}),
	).toEqual({ decision: "ask" })
})

it("remembers future project writes and exact commands in request approval", async () => {
	const state = {
		...request,
		projectPermissionProfile: {
			...request.projectPermissionProfile,
			approvedWorkspaceWrites: true,
			approvedCommands: ["pnpm test"],
		},
	}
	expect(
		await checkAutoApproval({ state, ask: "command", text: "pnpm test", commandExecution: workspaceCommand }),
	).toEqual({ decision: "approve" })
	expect(
		await checkAutoApproval({
			state,
			ask: "tool",
			text: JSON.stringify({ tool: "newFileCreated", path: "src/example.ts" }),
		}),
	).toEqual({ decision: "approve" })
})
