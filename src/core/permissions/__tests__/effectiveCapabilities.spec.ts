import { describe, expect, it } from "vitest"
import {
	normalizeProjectPermissionProfile,
	normalizeWorkflowMode,
	resolveEffectiveCapabilities,
} from "../effectiveCapabilities"

describe("effective capabilities", () => {
	it("accepts only request approval and auto approval", () => {
		expect(normalizeProjectPermissionProfile({ mode: "request-approval", updatedAt: 1 })).toMatchObject({
			mode: "request-approval",
		})
		expect(normalizeProjectPermissionProfile({ mode: "auto-approval", updatedAt: 2 })).toMatchObject({
			mode: "auto-approval",
		})
	})

	it("does not interpret removed permission modes", () => {
		for (const mode of ["observe", "unsupported", "safe-development", "automatic-development"]) {
			expect(normalizeProjectPermissionProfile({ mode, updatedAt: 1 })).toBeUndefined()
		}
	})

	it("keeps workflow selection separate from project approval", () => {
		expect(normalizeWorkflowMode("strict")).toBe("spec")
		expect(
			resolveEffectiveCapabilities({
				workflow: "plan",
				projectPermissionProfile: { mode: "auto-approval", updatedAt: 1 },
			}),
		).toMatchObject({
			workflow: "plan",
			canReadWorkspace: true,
			canWriteWorkspace: true,
			canExecuteWorkspaceCommand: true,
		})
	})
})
