import { describe, expect, it } from "vitest"
import {
	normalizeProjectPermissionProfile,
	normalizeWorkflowMode,
	resolveEffectiveCapabilities,
} from "../effectiveCapabilities"

describe("effective capabilities", () => {
	it("migrates removed permission modes to sandbox development", () => {
		expect(normalizeProjectPermissionProfile({ mode: "safe-development", updatedAt: 1 })).toEqual({
			mode: "sandbox-development",
			updatedAt: 1,
		})
		expect(normalizeProjectPermissionProfile({ mode: "automatic-development", updatedAt: 2 })).toEqual({
			mode: "sandbox-development",
			updatedAt: 2,
		})
	})

	it("migrates Strict to Spec and keeps Plan read-only", () => {
		expect(normalizeWorkflowMode("strict")).toBe("spec")
		expect(
			resolveEffectiveCapabilities({
				workflow: "plan",
				projectPermissionProfile: { mode: "sandbox-development", updatedAt: 1 },
			}),
		).toMatchObject({
			workflow: "plan",
			canReadWorkspace: true,
			canWriteWorkspace: false,
			canExecuteWorkspaceCommand: false,
			usesSandbox: true,
		})
	})
})
