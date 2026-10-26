import type { ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../task-persistence/apiMessages"

const USER_SAYS = new Set(["user_feedback", "user_feedback_diff"])
const ASSISTANT_SAYS = new Set(["text", "completion_result", "subtask_result"])
const ASSISTANT_ASKS = new Set(["followup", "multiple_choice", "completion_result"])

function appendTextMessage(messages: ApiMessage[], role: "user" | "assistant", text: string, ts?: number): void {
	const trimmed = text.trim()
	if (!trimmed) return

	const previous = messages.at(-1)
	if (previous?.role === role && !previous.isSummary) {
		const previousContent = Array.isArray(previous.content)
			? previous.content
			: [{ type: "text" as const, text: previous.content }]
		previous.content = [...previousContent, { type: "text", text: trimmed }]
		return
	}

	messages.push({ role, content: [{ type: "text", text: trimmed }], ...(ts ? { ts } : {}) })
}

/**
 * Rebuild a conservative, text-only model history for legacy tasks that have
 * ui_messages.json but no api_conversation_history.json.
 *
 * UI-only status, reasoning, checkpoint, command and tool-progress messages
 * are deliberately excluded. The first visible `say:text` is the original
 * user task (see Task.startTask); later `say:text` entries are assistant text.
 */
export function rebuildApiHistoryFromUiMessages(uiMessages: ClineMessage[]): ApiMessage[] {
	const rebuilt: ApiMessage[] = []
	let foundInitialTask = false

	for (const message of uiMessages) {
		if (!message.text?.trim()) continue
		if (message.type === "say" && message.say === "text" && !foundInitialTask) {
			appendTextMessage(rebuilt, "user", message.text, message.ts)
			foundInitialTask = true
			continue
		}
		if (message.type === "say" && message.say && USER_SAYS.has(message.say)) {
			appendTextMessage(rebuilt, "user", message.text, message.ts)
			continue
		}
		if (message.type === "say" && message.say && ASSISTANT_SAYS.has(message.say)) {
			appendTextMessage(rebuilt, "assistant", message.text, message.ts)
			continue
		}
		if (message.type === "ask" && message.ask && ASSISTANT_ASKS.has(message.ask)) {
			appendTextMessage(rebuilt, "assistant", message.text, message.ts)
		}
	}

	return rebuilt
}
