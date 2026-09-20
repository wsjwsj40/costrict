import type { ProjectPermissionMode, ProjectPermissionProfile } from "@roo-code/types"

/** User-facing workflow names. `strict` is accepted only while migrating old state. */
export type WorkflowMode = "vibe" | "plan" | "spec" | "raw"

export interface EffectiveCapabilities {
	workflow: WorkflowMode
	projectPermission?: ProjectPermissionMode
	canReadWorkspace: boolean
	canWriteWorkspace: boolean
	canExecuteWorkspaceCommand: boolean
}

export function normalizeWorkflowMode(mode: unknown): WorkflowMode {
	if (mode === "strict") return "spec"
	if (mode === "vibe" || mode === "plan" || mode === "spec" || mode === "raw") return mode
	return "vibe"
}

/** Accept only the two supported project permission modes. */
export function normalizeProjectPermissionProfile(profile: unknown): ProjectPermissionProfile | undefined {
	if (!profile || typeof profile !== "object") return undefined
	const value = profile as { mode?: unknown; updatedAt?: unknown }
	if (value.mode !== "request-approval" && value.mode !== "auto-approval") return undefined
	return {
		mode: value.mode,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		approvedCommands: Array.isArray((value as { approvedCommands?: unknown }).approvedCommands)
			? (value as { approvedCommands: unknown[] }).approvedCommands.filter(
					(command): command is string => typeof command === "string",
				)
			: [],
		approvedWorkspaceWrites: (value as { approvedWorkspaceWrites?: unknown }).approvedWorkspaceWrites === true,
	}
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
	const automaticApproval = profile?.mode === "auto-approval"

	return {
		workflow: normalizedWorkflow,
		projectPermission: profile?.mode,
		canReadWorkspace: true,
		canWriteWorkspace: automaticApproval || profile?.approvedWorkspaceWrites === true,
		canExecuteWorkspaceCommand: automaticApproval,
	}
}
