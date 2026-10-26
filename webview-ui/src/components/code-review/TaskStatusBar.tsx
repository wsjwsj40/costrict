import React from "react"
import { ReviewIssue, ReviewTaskStatus } from "@roo/codeReview"
import { InfoCircledIcon } from "@radix-ui/react-icons"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

interface TaskStatusBarProps {
	taskStatus: ReviewTaskStatus
	progress: number | null
	message: string
	reportPath?: string
	errorMessage: string
	issues: ReviewIssue[]
	onTaskCancel: () => void
}

const TaskStatusBar: React.FC<TaskStatusBarProps> = ({
	taskStatus,
	progress,
	issues,
	message,
	reportPath,
	errorMessage,
	onTaskCancel,
}) => {
	const { t } = useAppTranslation()
	return (
		<div className="flex flex-shrink-0 items-center mt-5">
			{taskStatus === ReviewTaskStatus.RUNNING && (
				<div className="mb-4">
					<div>
						<div className="flex items-center">
							<div
								className="w-4 h-4 rounded-full border-2 border-transparent animate-spin"
								style={{ borderTopColor: "rgba(23, 112, 230, 0.7)" }}
							/>
							{progress !== null && (
								<div>
									<span className="ml-2">
										{t("codereview:taskStatusBar.running", {
											progress: Math.round((progress ?? 0) * 100),
										})}
									</span>
									<span className="ml-2 text-[#1876F2] cursor-pointer" onClick={() => onTaskCancel()}>
										{t("codereview:taskStatusBar.cancel")}
									</span>
								</div>
							)}
							{message && <span className="ml-2">{message}</span>}
						</div>
					</div>
				</div>
			)}
			{taskStatus === ReviewTaskStatus.COMPLETED && issues.length === 0 && (
				<div className="flex items-center mb-4">
					<InfoCircledIcon color="#D19A00" width={20} height={20} />
					<span className="ml-2">{message || t("codereview:taskStatusBar.completed")}</span>
					{reportPath && (
						<button
							type="button"
							className="ml-2 text-[#1876F2] cursor-pointer"
							onClick={() => vscode.postMessage({ type: "openFile", text: reportPath })}>
							{t("codereview:taskStatusBar.openReport")}
						</button>
					)}
				</div>
			)}
			{taskStatus === ReviewTaskStatus.COMPLETED && issues.length > 0 && message && (
				<div className="flex items-center mb-4 text-vscode-descriptionForeground">
					<InfoCircledIcon color="#D19A00" width={20} height={20} />
					<span className="ml-2">{message}</span>
					{reportPath && (
						<button
							type="button"
							className="ml-2 text-[#1876F2] cursor-pointer"
							onClick={() => vscode.postMessage({ type: "openFile", text: reportPath })}>
							{t("codereview:taskStatusBar.openReport")}
						</button>
					)}
				</div>
			)}
			{taskStatus === ReviewTaskStatus.ERROR && (
				<div className="w-full mb-4">
					<div className="w-full flex items-center">
						<InfoCircledIcon
							className="text-[#E64545] leading-[17px] flex-shrink-0 mt-0.5"
							width={20}
							height={20}
						/>
						<span className="ml-2 text-[#E64545] leading-[17px] break-words flex-1 min-w-0">
							{errorMessage ?? ""}
						</span>
					</div>
				</div>
			)}
		</div>
	)
}

export default TaskStatusBar
