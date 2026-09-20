import * as path from "path"

import { parseCommand } from "../../shared/parse-command"

export type CommandScope = "workspace" | "outside"

/** Whether a resolved path is contained by the resolved workspace directory. */
export function isWithinWorkspace(workspace: string, candidate: string): boolean {
	const relative = path.relative(workspace, candidate)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function getCommandScope(workspace: string, cwd: string): CommandScope {
	return isWithinWorkspace(workspace, cwd) ? "workspace" : "outside"
}

/**
 * These commands remain one-time approvals in every permission mode. This is
 * a policy decision, not a runtime isolation mechanism.
 */
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
