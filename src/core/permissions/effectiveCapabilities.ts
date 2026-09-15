import type { ProjectPermissionMode, ProjectPermissionProfile } from "@roo-code/types"

/** User-facing workflow names. `strict` is accepted only while migrating old state. */
export type WorkflowMode = "vibe" | "plan" | "spec" | "raw"

export type LegacyProjectPermissionMode = ProjectPermissionMode | "safe-development" | "automatic-development"

export interface EffectiveCapabilities {
	workflow: WorkflowMode
	projectPermission?: ProjectPermissionMode
	canReadWorkspace: boolean
	canWriteWorkspace: boolean
	canExecuteWorkspaceCommand: boolean
	usesSandbox: boolean
}

export function normalizeWorkflowMode(mode: unknown): WorkflowMode {
	if (mode === "strict") return "spec"
	if (mode === "vibe" || mode === "plan" || mode === "spec" || mode === "raw") return mode
	return "vibe"
}

/** Converts settings written by earlier versions to the smaller current model. */
export function normalizeProjectPermissionProfile(profile: unknown): ProjectPermissionProfile | undefined {
	if (!profile || typeof profile !== "object") return undefined
	const value = profile as { mode?: LegacyProjectPermissionMode; updatedAt?: unknown }
	const mode =
		value.mode === "observe"
			? "observe"
			: value.mode === "sandbox-development" ||
				  value.mode === "safe-development" ||
				  value.mode === "automatic-development"
				? "sandbox-development"
				: undefined
	if (!mode) return undefined
	return { mode, updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0 }
}

/** The single source of truth for workflow and project trust capabilities. */
export function resolveEffectiveCapabilities({
	workflow,
	projectPermissionProfile,
}: {
	workflow?: unknown
	projectPermissionProfile?: unknown
}): EffectiveCapabilities {
	const normalizedWorkflow = normalizeWorkflowMode(workflow)
	const profile = normalizeProjectPermissionProfile(projectPermissionProfile)
	const sandboxDevelopment = profile?.mode === "sandbox-development"
	const workflowAllowsMutation = normalizedWorkflow !== "plan"

	return {
		workflow: normalizedWorkflow,
		projectPermission: profile?.mode,
		canReadWorkspace: true,
		canWriteWorkspace: sandboxDevelopment && workflowAllowsMutation,
		canExecuteWorkspaceCommand: sandboxDevelopment && workflowAllowsMutation,
		// A one-time command approval in a read-only project still runs in the
		// sandbox. The flag describes its execution boundary, not auto-approval.
		usesSandbox: profile !== undefined,
	}
}
