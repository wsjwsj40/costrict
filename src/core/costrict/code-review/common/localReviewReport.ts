import { IssueStatus, SeverityLevel, type ReviewIssue } from "../../../../shared/codeReview"

type RecordValue = Record<string, unknown>

/** The report summary convention lists non-zero severity totals as 高 1 / Medium: 2, etc. */
export function reportMentionsFindings(text: string): boolean {
	return /(?:^|[^\p{L}])(?:高|中|低|high|medium|low)[ \t]*[:：]?[ \t]*[1-9]\d*(?=\D|$)/imu.test(text)
}

function asRecord(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined
}

function firstString(source: RecordValue, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = source[key]
		if (typeof value === "string" && value.trim()) return value.trim()
	}
	return undefined
}

function firstLine(source: RecordValue, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = source[key]
		const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
		if (Number.isInteger(number) && number > 0) return number
	}
	return undefined
}

function parseSeverity(value: unknown): SeverityLevel {
	if (value === 3 || /^(high|critical|严重|高)$/i.test(String(value))) return SeverityLevel.HIGH
	if (value === 2 || /^(medium|middle|中)$/i.test(String(value))) return SeverityLevel.MIDDLE
	if (value === 1 || /^(low|低)$/i.test(String(value))) return SeverityLevel.LOW
	return SeverityLevel.UNKNOWN
}

/** Extract actual findings from the local JSON artifact without inventing findings from Markdown prose. */
export function parseLocalReviewReport(content: string, taskId: string): ReviewIssue[] | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch {
		return null
	}
	const root = asRecord(parsed)
	if (!root) return null
	const containers = [root, asRecord(root.report), asRecord(root.data)].filter(
		(value): value is RecordValue => !!value,
	)
	let findings: unknown[] | undefined
	for (const container of containers) {
		for (const key of ["defects", "issues", "findings"]) {
			if (Array.isArray(container[key])) {
				findings = container[key] as unknown[]
				break
			}
		}
		if (findings) break
	}
	if (!findings) return null

	return findings.map((raw, index) => {
		const item = asRecord(raw) ?? {}
		const location = asRecord(item.location) ?? {}
		let filePath = firstString(item, ["file_path", "filePath", "path", "file", "filename"])
		filePath ??= firstString(location, ["file_path", "filePath", "path", "file", "filename"])
		let startLine = firstLine(item, ["start_line", "startLine", "line", "line_number"])
		startLine ??= firstLine(location, ["start_line", "startLine", "line", "line_number"])
		if (filePath && !startLine) {
			const pathWithLine = /^(.*):(\d+)(?:-(\d+))?$/.exec(filePath)
			if (pathWithLine) {
				filePath = pathWithLine[1]
				startLine = Number(pathWithLine[2])
			}
		}
		const message =
			firstString(item, ["message", "description", "detail", "details", "reason", "evidence"]) ??
			(typeof raw === "string" ? raw : JSON.stringify(raw) || "Report finding")
		const title = firstString(item, ["title", "summary", "name"]) ?? message.split("\n")[0].slice(0, 120)
		const issueTypes = Array.isArray(item.issue_types)
			? item.issue_types.filter((value): value is string => typeof value === "string")
			: [firstString(item, ["category", "issue_type", "type"])].filter((value): value is string => !!value)
		const reportedEndLine = firstLine(item, ["end_line", "endLine"]) ?? firstLine(location, ["end_line", "endLine"])
		return {
			id: `local-report:${taskId}:${index}`,
			source: "local-report" as const,
			file_path: filePath ?? "[review report]",
			start_line: startLine ?? 1,
			end_line: Math.max(startLine ?? 1, reportedEndLine ?? startLine ?? 1),
			title,
			message,
			issue_types: issueTypes,
			severity: parseSeverity(item.severity ?? item.level ?? item.priority),
			status: IssueStatus.INITIAL,
			confidence: typeof item.confidence === "number" ? item.confidence : 0,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			fix_code: firstString(item, ["fix_code", "fixCode"]) ?? "",
			...(!filePath
				? { location_status: "unresolved" as const, location_reason: "The report did not specify a file path." }
				: {}),
		}
	})
}
