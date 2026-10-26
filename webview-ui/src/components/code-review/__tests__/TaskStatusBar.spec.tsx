import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { ReviewTaskStatus } from "@roo/codeReview"
import { vscode } from "@src/utils/vscode"

import TaskStatusBar from "../TaskStatusBar"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

it("does not claim an empty structured result means a clean review and opens the report", () => {
	render(
		<TaskStatusBar
			taskStatus={ReviewTaskStatus.COMPLETED}
			progress={1}
			issues={[]}
			message=""
			errorMessage=""
			reportPath="/project/code-review_result/review-report.md"
			onTaskCancel={vi.fn()}
		/>,
	)

	expect(screen.getByText("codereview:taskStatusBar.completed")).toBeInTheDocument()
	fireEvent.click(screen.getByRole("button", { name: "codereview:taskStatusBar.openReport" }))
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "openFile",
		text: "/project/code-review_result/review-report.md",
	})
})
