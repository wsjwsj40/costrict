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

it("uses current-task grants for ordinary writes and exact commands", async () => {
	const state = {
		...request,
		projectPermissionProfile: {
			...request.projectPermissionProfile,
			approvedWorkspaceWrites: true,
			approvedCommandRules: [{ cwd: "/project", command: "python script.py" }],
		},
	}
	expect(
		await checkAutoApproval({
			state,
			ask: "command",
			text: "python script.py",
			commandExecution: workspaceCommand,
		}),
	).toEqual({ decision: "approve" })
	expect(
		await checkAutoApproval({ state, ask: "command", text: "python other.py", commandExecution: workspaceCommand }),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state,
			ask: "command",
			text: "python script.py",
			commandExecution: { cwd: "/project/subrepo", scope: "workspace" },
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state,
			ask: "tool",
			text: JSON.stringify({ tool: "newFileCreated", path: "src/example.ts" }),
		}),
	).toEqual({ decision: "approve" })
	for (const operation of ["delete", "move"] as const) {
		expect(
			await checkAutoApproval({
				state,
				ask: "tool",
				text: JSON.stringify({ tool: "appliedDiff", path: "src/example.ts", operation }),
			}),
		).toEqual({ decision: "ask" })
	}
	expect(
		await checkAutoApproval({
			state,
			ask: "tool",
			text: JSON.stringify({ tool: "generateImage", path: "src/example.png" }),
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state,
			ask: "tool",
			text: JSON.stringify({ tool: "appliedDiff", batchDiffs: [{ path: "src/a.ts" }] }),
		}),
	).toEqual({ decision: "ask" })
	expect(
		await checkAutoApproval({
			state,
			ask: "tool",
			text: JSON.stringify({ tool: "appliedDiff", path: "src/protected.ts", isProtected: true }),
		}),
	).toEqual({ decision: "ask" })
})

it("requires fresh approval when Git diff revisions or options change", async () => {
	const state = {
		...request,
		projectPermissionProfile: {
			...request.projectPermissionProfile,
			approvedCommandRules: [{ cwd: "/project", command: "git diff abcdef1" }],
		},
	}
	expect(
		await checkAutoApproval({
			state,
			ask: "command",
			text: "git diff abcdef1",
			commandExecution: workspaceCommand,
		}),
	).toEqual({
		decision: "approve",
	})
	for (const command of [
		"git diff",
		"git diff 1234567",
		"git diff abcdef1 1234567",
		"git diff --stat abcdef1",
		"git push",
	]) {
		expect(
			await checkAutoApproval({ state, ask: "command", text: command, commandExecution: workspaceCommand }),
		).toEqual({
			decision: "ask",
		})
	}
})
