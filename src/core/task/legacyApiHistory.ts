import type { ApiMessage } from "../task-persistence/apiMessages"

const LEGACY_NO_TOOL_PREFIX = "[ERROR] You did not use a tool in your previous response!"
const LEGACY_TOOL_NAMES = [
	"attempt_completion",
	"update_todo_list",
	"ask_followup_question",
	"read_file",
	"write_to_file",
	"apply_diff",
	"execute_command",
	"search_files",
	"list_files",
	"use_mcp_tool",
	"access_mcp_resource",
	"new_task",
	"switch_mode",
] as const

export interface LegacyApiHistorySanitizeResult {
	messages: ApiMessage[]
	removedAutomatedMessages: number
	removedEnvironmentBlocks: number
	convertedToolBlocks: number
	incompleteToolNames: string[]
	recoveryCandidates: LegacyToolRecoveryCandidate[]
}

export interface LegacyToolRecoveryCandidate {
	legacyToolName: string
	recoveredArguments: Record<string, string>
}

function extractClosedLegacyArguments(xml: string): Record<string, string> {
	const argumentsByName: Record<string, string> = {}
	const parameterPattern = /<([a-zA-Z][\w-]*)>\s*([\s\S]*?)\s*<\/\1>/g
	for (const match of xml.matchAll(parameterPattern)) {
		const [, name, value] = match
		if (!LEGACY_TOOL_NAMES.includes(name as (typeof LEGACY_TOOL_NAMES)[number])) {
			argumentsByName[name] = value.trim()
		}
	}
	return argumentsByName
}

export function containsLegacyXmlToolHistory(messages: ApiMessage[]): boolean {
	return messages.some((message) => {
		const content = message.content
		return Array.isArray(content)
			? content.some(
					(block) =>
						block.type === "text" &&
						typeof block.text === "string" &&
						(LEGACY_TOOL_NAMES.some((name) => block.text.includes(`<${name}>`)) ||
							block.text.includes(LEGACY_NO_TOOL_PREFIX)),
				)
			: typeof content === "string" &&
					(LEGACY_TOOL_NAMES.some((name) => content.includes(`<${name}>`)) ||
						content.includes(LEGACY_NO_TOOL_PREFIX))
	})
}

function sanitizeText(text: string, stats: Omit<LegacyApiHistorySanitizeResult, "messages">): string | undefined {
	if (text.trimStart().startsWith(LEGACY_NO_TOOL_PREFIX)) {
		stats.removedAutomatedMessages += 1
		return undefined
	}

	let sanitized = text.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, () => {
		stats.removedEnvironmentBlocks += 1
		return ""
	})

	sanitized = sanitized.replace(/<attempt_completion>\s*([\s\S]*?)\s*<\/attempt_completion>/gi, (_match, body) => {
		stats.convertedToolBlocks += 1
		return String(body).trim()
	})

	sanitized = sanitized.replace(/<update_todo_list>\s*([\s\S]*?)\s*<\/update_todo_list>/gi, (_match, body) => {
		stats.convertedToolBlocks += 1
		return `[Legacy task status]\n${String(body).trim()}`
	})

	for (const toolName of LEGACY_TOOL_NAMES) {
		if (toolName === "attempt_completion" || toolName === "update_todo_list") continue
		const paired = new RegExp(`<${toolName}>\\s*([\\s\\S]*?)\\s*</${toolName}>`, "gi")
		sanitized = sanitized.replace(paired, (_match, body) => {
			stats.convertedToolBlocks += 1
			return `[Legacy tool record: ${toolName}]\n${String(body).trim()}`
		})
	}

	for (const toolName of LEGACY_TOOL_NAMES) {
		const openingTag = `<${toolName}>`
		const openingIndex = sanitized.indexOf(openingTag)
		if (openingIndex === -1) continue
		const legacyFragment = sanitized.slice(openingIndex + openingTag.length)
		const recoveredArguments = extractClosedLegacyArguments(legacyFragment)
		stats.incompleteToolNames.push(toolName)
		stats.recoveryCandidates.push({ legacyToolName: toolName, recoveredArguments })
		sanitized = `${sanitized.slice(0, openingIndex).trimEnd()}\n[Legacy tool recovery candidate]\nTool: ${toolName}\nRecovered arguments: ${JSON.stringify(recoveredArguments)}\nExecution status: not executed\nRequired action: Do not replay or emit XML tool syntax. Ask the user whether this interrupted operation is still wanted. Only after the user explicitly confirms, re-evaluate the operation against the current workspace and conversation, obtain any missing parameters, and invoke the equivalent tool through the current native tool-calling interface.`
	}

	const trimmed = sanitized.trim()
	return trimmed || undefined
}

export function sanitizeLegacyApiHistory(messages: ApiMessage[]): LegacyApiHistorySanitizeResult {
	const stats: Omit<LegacyApiHistorySanitizeResult, "messages"> = {
		removedAutomatedMessages: 0,
		removedEnvironmentBlocks: 0,
		convertedToolBlocks: 0,
		incompleteToolNames: [],
		recoveryCandidates: [],
	}
	const sanitizedMessages: ApiMessage[] = []

	for (const message of messages) {
		const content = Array.isArray(message.content)
			? message.content.flatMap((block) => {
					if (block.type !== "text" || typeof block.text !== "string") return [block]
					const text = sanitizeText(block.text, stats)
					return text ? [{ ...block, text }] : []
				})
			: sanitizeText(message.content, stats)

		if ((Array.isArray(content) && content.length === 0) || content === undefined) continue
		const sanitizedMessage = { ...message, content } as ApiMessage
		const previous = sanitizedMessages.at(-1)
		if (
			previous &&
			(previous.role === "user" || previous.role === "assistant") &&
			previous.role === sanitizedMessage.role &&
			!previous.isSummary &&
			!sanitizedMessage.isSummary
		) {
			const previousContent = Array.isArray(previous.content)
				? previous.content
				: [{ type: "text" as const, text: previous.content }]
			const nextContent = Array.isArray(sanitizedMessage.content)
				? sanitizedMessage.content
				: [{ type: "text" as const, text: sanitizedMessage.content }]
			previous.content = [...previousContent, ...nextContent]
			continue
		}
		sanitizedMessages.push(sanitizedMessage)
	}

	return { messages: sanitizedMessages, ...stats }
}
