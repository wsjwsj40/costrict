import { describe, expect, it } from "vitest"

import { PROJECT_WIKI_TEMPLATE as englishTemplate } from "./en/project-wiki.js"
import { PROJECT_WIKI_TEMPLATE as chineseTemplate } from "./zh-CN/project-wiki.js"

describe("project wiki orchestration prompt", () => {
	it.each([
		["English", englishTemplate({ workspace: "C:\\workspace" })],
		["Chinese", chineseTemplate({ workspace: "C:\\workspace" })],
	])("keeps workspace access in delegated Code tasks for %s", (_language, prompt) => {
		expect(prompt).toContain("new_task")
		expect(prompt).toContain("attempt_completion.result")
		expect(prompt).toContain("document_count")
		expect(prompt).toContain("catalogue.json")
		expect(prompt).not.toContain("swtich_mode")
		expect(prompt).not.toMatch(/Task 3: Read Documentation Structure Definition|任务3：读取文档结构定义/)
	})
})
