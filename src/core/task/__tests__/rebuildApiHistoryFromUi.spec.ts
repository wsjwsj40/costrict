import { describe, expect, it } from "vitest"
import type { ClineMessage } from "@roo-code/types"

import { rebuildApiHistoryFromUiMessages } from "../rebuildApiHistoryFromUi"

describe("rebuildApiHistoryFromUiMessages", () => {
	it("rebuilds user and assistant text without UI-only records", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "Original user question" },
			{ ts: 2, type: "say", say: "api_req_started", text: "request metadata" },
			{ ts: 3, type: "say", say: "reasoning", text: "hidden chain of thought" },
			{ ts: 4, type: "say", say: "text", text: "Assistant answer" },
			{ ts: 5, type: "ask", ask: "resume_task", text: "resume control" },
			{ ts: 6, type: "say", say: "user_feedback", text: "User follow-up" },
			{ ts: 7, type: "ask", ask: "followup", text: "Assistant question" },
		]

		expect(rebuildApiHistoryFromUiMessages(messages)).toEqual([
			{ role: "user", content: [{ type: "text", text: "Original user question" }], ts: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Assistant answer" }], ts: 4 },
			{ role: "user", content: [{ type: "text", text: "User follow-up" }], ts: 6 },
			{ role: "assistant", content: [{ type: "text", text: "Assistant question" }], ts: 7 },
		])
	})

	it("merges adjacent messages with the same inferred role", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "Task" },
			{ ts: 2, type: "say", say: "text", text: "Part one" },
			{ ts: 3, type: "say", say: "completion_result", text: "Part two" },
		]

		const rebuilt = rebuildApiHistoryFromUiMessages(messages)
		expect(rebuilt).toHaveLength(2)
		expect(rebuilt[1].content).toEqual([
			{ type: "text", text: "Part one" },
			{ type: "text", text: "Part two" },
		])
	})
})
