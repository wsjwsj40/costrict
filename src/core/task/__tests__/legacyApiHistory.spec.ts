import { describe, expect, it } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { containsLegacyXmlToolHistory, sanitizeLegacyApiHistory } from "../legacyApiHistory"

describe("legacy API history compatibility", () => {
	it("converts legacy completion and todo XML while removing generated control context", () => {
		const messages: ApiMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "<attempt_completion>\nThe answer is 42.\n</attempt_completion>" }],
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[ERROR] You did not use a tool in your previous response! Please retry with a tool use.\n(This is an automated message, so do not respond to it conversationally.)",
					},
					{
						type: "text",
						text: "<environment_details>\nOld workspace details\n</environment_details>",
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "<update_todo_list>\n<todos>done</todos>\n</update_todo_list>",
					},
				],
			},
		]
		const original = structuredClone(messages)

		const result = sanitizeLegacyApiHistory(messages)

		expect(result.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "The answer is 42." },
					{ type: "text", text: "[Legacy task status]\n<todos>done</todos>" },
				],
			},
		])
		expect(result.removedAutomatedMessages).toBe(1)
		expect(result.removedEnvironmentBlocks).toBe(1)
		expect(result.convertedToolBlocks).toBe(2)
		expect(messages).toEqual(original)
	})

	it("keeps completed legacy tools as inert text records", () => {
		const result = sanitizeLegacyApiHistory([
			{
				role: "assistant",
				content: [{ type: "text", text: "<read_file>\n<path>README.md</path>\n</read_file>" }],
			},
		])

		expect((result.messages[0].content[0] as { text: string }).text).toBe(
			"[Legacy tool record: read_file]\n<path>README.md</path>",
		)
		expect(result.incompleteToolNames).toEqual([])
	})

	it("marks an unfinished legacy tool call for confirmation instead of replaying it", () => {
		const result = sanitizeLegacyApiHistory([
			{
				role: "assistant",
				content: [{ type: "text", text: "I will update it.\n<write_to_file>\n<path>a.ts</path>" }],
			},
		])

		expect((result.messages[0].content[0] as { text: string }).text).toContain("[Legacy tool recovery candidate]")
		expect((result.messages[0].content[0] as { text: string }).text).toContain(
			"current native tool-calling interface",
		)
		expect(result.incompleteToolNames).toEqual(["write_to_file"])
		expect(result.recoveryCandidates).toEqual([
			{ legacyToolName: "write_to_file", recoveredArguments: { path: "a.ts" } },
		])
	})

	it("does not activate for current native tool history", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "Read README.md" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } }],
			},
		]

		expect(containsLegacyXmlToolHistory(messages)).toBe(false)
		expect(sanitizeLegacyApiHistory(messages).messages).toEqual(messages)
	})

	it("detects XML tool history and legacy no-tool reminders", () => {
		expect(
			containsLegacyXmlToolHistory([
				{ role: "assistant", content: "<attempt_completion>done</attempt_completion>" },
			]),
		).toBe(true)
		expect(
			containsLegacyXmlToolHistory([
				{ role: "user", content: "[ERROR] You did not use a tool in your previous response!" },
			]),
		).toBe(true)
	})
})
