import path from "path"
import type { SkillContent } from "../../shared/skills"

export interface SkillLookup {
	getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null>
}

export async function resolveSkillContentForMode(
	skillsManager: SkillLookup | undefined,
	skillName: string,
	currentMode: string,
): Promise<SkillContent | null> {
	if (!skillsManager) {
		return null
	}

	return skillsManager.getSkillContent(skillName, currentMode)
}

type SkillContentForFormatting = Pick<SkillContent, "source" | "description" | "instructions" | "path">

export function buildSkillApprovalMessage(
	skillName: string,
	args: string | undefined,
	skillContent: Pick<SkillContent, "source" | "description">,
): string {
	return JSON.stringify({
		tool: "skill",
		skill: skillName,
		args,
		source: skillContent.source,
		description: skillContent.description,
	})
}

export function buildSkillResult(
	skillName: string,
	args: string | undefined,
	skillContent: SkillContentForFormatting,
): string {
	let result = `Skill: ${skillName}`

	if (skillContent.description) {
		result += `\nDescription: ${skillContent.description}`
	}

	if (args) {
		result += `\nProvided arguments: ${args}`
	}

	result += `\nSource: ${skillContent.source}`
	result += `\nSkill file: ${skillContent.path}`
	result += `\nSkill root: ${path.dirname(skillContent.path)}`
	result +=
		"\nRelative resource rule: Resolve every relative file or directory referenced by these instructions against Skill root, not the workspace. Read required referenced resources before proceeding."
	result += `\n\n--- Skill Instructions ---\n\n${skillContent.instructions}`

	return result
}
