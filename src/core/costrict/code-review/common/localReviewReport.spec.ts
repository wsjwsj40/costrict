import { describe, expect, it } from "vitest"

import { SeverityLevel } from "../../../../shared/codeReview"
import { parseLocalReviewReport } from "./localReviewReport"

describe("parseLocalReviewReport", () => {
	it("recovers each reported defect with file, line, details, and severity", () => {
		const issues = parseLocalReviewReport(
			JSON.stringify({
				defects: [
					{
						file_path: "src/a.ts",
						start_line: 12,
						severity: "高",
						title: "SQL injection",
						description: "Input reaches a SQL query without escaping",
						category: "security",
					},
					{ location: { file: "src/b.ts", line: 7 }, message: "Missing null check", severity: "medium" },
				],
			}),
			"review-1",
		)

		expect(issues).toHaveLength(2)
		expect(issues?.[0]).toMatchObject({
			id: "local-report:review-1:0",
			source: "local-report",
			file_path: "src/a.ts",
			start_line: 12,
			severity: SeverityLevel.HIGH,
			message: "Input reaches a SQL query without escaping",
			issue_types: ["security"],
		})
		expect(issues?.[1]).toMatchObject({ file_path: "src/b.ts", start_line: 7, severity: SeverityLevel.MIDDLE })
	})

	it("keeps every report entry visible even when metadata is incomplete", () => {
		const issues = parseLocalReviewReport(JSON.stringify({ findings: [{ title: "Unlocated issue" }] }), "review-2")
		expect(issues).toHaveLength(1)
		expect(issues?.[0]).toMatchObject({
			file_path: "[review report]",
			severity: SeverityLevel.UNKNOWN,
			location_status: "unresolved",
		})
	})

	it("does not invent findings from arbitrary objects or invalid JSON", () => {
		expect(parseLocalReviewReport('{"summary":"2 issues"}', "review-3")).toBeNull()
		expect(parseLocalReviewReport("{invalid", "review-3")).toBeNull()
	})
})
