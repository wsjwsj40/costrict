import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { IssueStatus, SeverityLevel, type ReviewIssue } from "@roo/codeReview"
import { vscode } from "@src/utils/vscode"

import IssueItem from "../IssueItem"

beforeEach(() => vi.clearAllMocks())

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const issue: ReviewIssue = {
	id: "local-report:task:0",
	source: "local-report",
	file_path: "src/a.ts",
	resolved_file_path: "/repo/child/src/a.ts",
	start_line: 12,
	end_line: 12,
	title: "Missing check",
	message: "Detailed explanation from the report",
	issue_types: ["logic"],
	severity: SeverityLevel.HIGH,
	status: IssueStatus.INITIAL,
	confidence: 0,
	created_at: "",
	updated_at: "",
	fix_code: "",
	location_status: "current",
}

it("shows recovered details and opens the exact repository file without requesting server issue actions", () => {
	const onIssueClick = vi.fn()
	render(<IssueItem issue={issue} onIssueClick={onIssueClick} />)

	expect(screen.getByText(issue.message)).toBeInTheDocument()
	fireEvent.click(screen.getByText(issue.title!))
	expect(onIssueClick).not.toHaveBeenCalled()
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "openFile",
		text: "/repo/child/src/a.ts",
		values: { line: 12 },
	})
})

it("keeps historical files viewable as report details without opening a missing file", () => {
	const onIssueClick = vi.fn()
	render(<IssueItem issue={{ ...issue, location_status: "target-version" }} onIssueClick={onIssueClick} />)

	expect(screen.getByText(issue.message)).toBeInTheDocument()
	fireEvent.click(screen.getByText(issue.title!))
	expect(onIssueClick).not.toHaveBeenCalled()
	expect(vscode.postMessage).not.toHaveBeenCalled()
})
