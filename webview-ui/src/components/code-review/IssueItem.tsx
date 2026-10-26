import React from "react"
import { ReviewIssue, IssueStatus } from "@roo/codeReview"
import { severityColor } from "./contants"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface IssueItemProps {
	issue: ReviewIssue
	onIssueClick: (issueId: string) => void
	renderAction?: (issue: ReviewIssue) => React.ReactNode
}

const IssueItem: React.FC<IssueItemProps> = ({ issue, onIssueClick, renderAction }) => {
	const { t } = useAppTranslation()
	const colors = severityColor()
	const isLocalReportIssue = issue.source === "local-report"
	const isNotInitial = ![IssueStatus.INITIAL, IssueStatus.IGNORE].includes(issue.status)
	const canOpenLocation = !issue.location_status || issue.location_status === "current"
	const badges = (issue.issue_types ?? []).map((type, i) => {
		return (
			<div
				key={i}
				className="h-4 text-[#E6C000] truncate flex justify-center items-center px-4 py-3 rounded-[20px] bg-[rgba(230,192,0,0.1)]">
				{type}
			</div>
		)
	})
	return (
		<div
			className={`w-full flex mt-[2px] pr-5 ${canOpenLocation ? "hover:bg-vscode-list-hoverBackground cursor-pointer" : "cursor-default"}`}
			style={{ opacity: isNotInitial ? 0.6 : 1 }}
			onClick={() => {
				if (!canOpenLocation) return
				if (isLocalReportIssue) {
					vscode.postMessage({
						type: "openFile",
						text: issue.resolved_file_path ?? issue.file_path,
						values: { line: issue.start_line },
					})
				} else {
					onIssueClick(issue.id)
				}
			}}>
			<div className="w-[2px]" style={{ backgroundColor: colors[issue.severity] }}></div>
			<div className="pl-3 py-[5px] flex-1" style={{ width: "calc(100% - 2px)" }}>
				<div className="flex items-center h-4 gap-2">
					<div className="flex-1 text-vscode-foreground truncate">{issue.title || issue.message}</div>
					{renderAction && <div className="flex-shrink-0">{renderAction(issue)}</div>}
				</div>
				<div className="flex flex-wrap gap-1 mt-2">{badges}</div>
				{isLocalReportIssue && (
					<>
						<div className="mt-2 whitespace-pre-wrap text-sm">{issue.message}</div>
						<div className="mt-1 text-xs text-vscode-descriptionForeground">
							{t("codereview:codeReviewContent.localReportIssue")}
						</div>
					</>
				)}
				{issue.location_reason && (
					<div className="mt-2 text-xs text-vscode-descriptionForeground">{issue.location_reason}</div>
				)}
			</div>
		</div>
	)
}

export default IssueItem
