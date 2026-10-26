import { useState, useEffect, useCallback } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useEvent } from "react-use"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import ReviewControlBar from "./ReviewControlBar"
import FileListPreview from "./FileListPreview"

interface FileChangeItem {
	path: string
	status: string
	oldPath?: string
}

interface GitCommit {
	hash: string
	shortHash: string
	subject: string
	author: string
	date: string
}

interface ReviewRepository {
	path: string
	name: string
}

type ReviewScope = "uncommitted" | "commit"

interface WelcomePageProps {
	onStartReview: () => void
}

const WelcomePage: React.FC<WelcomePageProps> = ({ onStartReview }) => {
	const { t } = useAppTranslation()
	const { hasClosedCodeReviewWelcomeTips } = useExtensionState()
	const [files, setFiles] = useState<FileChangeItem[]>([])
	const [isLoading, setIsLoading] = useState(false)
	const [scope, setScope] = useState<ReviewScope>("uncommitted")
	const [commits, setCommits] = useState<GitCommit[]>([])
	const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null)
	const [commitQuery, setCommitQuery] = useState("")
	const [repositories, setRepositories] = useState<ReviewRepository[]>([])
	const [repositoryPath, setRepositoryPath] = useState("")

	// Request file list when component mounts
	useEffect(() => {
		setIsLoading(true)
		vscode.postMessage({ type: "getReviewRepositories" })
	}, [])

	// Handle messages from extension
	const handleMessage = useCallback((event: MessageEvent) => {
		const message = event.data
		if (message.type === "reviewFilesResponse") {
			const { files: responseFiles } = message.payload || {}
			setFiles(responseFiles || [])
			setIsLoading(false)
		} else if (message.type === "reviewCommitsResponse") {
			setCommits(message.commits || [])
			setIsLoading(false)
		} else if (message.type === "commitReviewFilesResponse") {
			setFiles(message.payload?.files || [])
			setIsLoading(false)
		} else if (message.type === "reviewRepositoriesResponse") {
			const availableRepositories = message.payload?.repositories || []
			setRepositories(availableRepositories)
			const defaultRepository = availableRepositories[0]?.path || ""
			setRepositoryPath(defaultRepository)
			vscode.postMessage({ type: "getReviewFiles", values: { repositoryPath: defaultRepository } })
		}
	}, [])

	useEvent("message", handleMessage)

	const requestCommits = (query = "") => {
		setIsLoading(true)
		vscode.postMessage({ type: "getReviewCommits", query, values: { repositoryPath } })
	}

	const handleStartReview = (mode?: string) => {
		vscode.postMessage({
			type: "createReviewTask",
			payload: { files, mode, commit: selectedCommit?.hash, repositoryPath },
		})
		onStartReview() // Immediately switch to Review page
	}

	const handleRefresh = () => {
		setIsLoading(true)
		if (scope === "commit") {
			if (selectedCommit) {
				vscode.postMessage({
					type: "getCommitReviewFiles",
					values: { commit: selectedCommit.hash, repositoryPath },
				})
			} else {
				requestCommits(commitQuery)
			}
		} else {
			vscode.postMessage({ type: "getReviewFiles", values: { repositoryPath } })
		}
	}

	const handleScopeChange = (value: ReviewScope) => {
		setScope(value)
		setSelectedCommit(null)
		setFiles([])
		if (value === "commit") {
			requestCommits()
		} else {
			setIsLoading(true)
			vscode.postMessage({ type: "getReviewFiles", values: { repositoryPath } })
		}
	}

	const handleCommitChange = (hash: string) => {
		const commit = commits.find((item) => item.hash === hash) ?? null
		setSelectedCommit(commit)
		setFiles([])
		if (commit) {
			setIsLoading(true)
			vscode.postMessage({ type: "getCommitReviewFiles", values: { commit: commit.hash, repositoryPath } })
		}
	}

	const handleRepositoryChange = (nextRepositoryPath: string) => {
		setRepositoryPath(nextRepositoryPath)
		setSelectedCommit(null)
		setFiles([])
		setIsLoading(true)
		if (scope === "commit") {
			vscode.postMessage({
				type: "getReviewCommits",
				query: commitQuery,
				values: { repositoryPath: nextRepositoryPath },
			})
		} else {
			vscode.postMessage({ type: "getReviewFiles", values: { repositoryPath: nextRepositoryPath } })
		}
	}
	const Tips = () => {
		const handleDismiss = () => {
			vscode.postMessage({
				type: "setCodeReviewWelcomeTips",
				payload: { value: true },
			})
		}

		return (
			<div className="flex justify-between bg-[#2D2D30] text-white p-4 px-5 rounded-lg text-base ml-4 mr-4 mt-4">
				<div className="flex items-center">
					<i className="codicon codicon-lightbulb" style={{ color: "rgba(255, 252, 196, 0.7)" }} />
					<span className="ml-1">{t("codereview:welcomePage.tips")}</span>
				</div>
				<span className="text-[#85858D] cursor-pointer" onClick={handleDismiss}>
					{t("codereview:welcomePage.dismiss")}
				</span>
			</div>
		)
	}
	return (
		<div className="welcome-page-container flex flex-col h-full w-full bg-vscode-sideBar-background text-vscode-foreground">
			<div className="welcome-page flex flex-col w-full max-w-[800px] mx-auto">
				{!hasClosedCodeReviewWelcomeTips && <Tips />}
				<div className="px-5 mt-4">
					<div className="mb-4 space-y-2">
						{repositories.length > 1 && (
							<>
								<label className="block text-sm font-medium" htmlFor="review-repository">
									{t("codereview:welcomePage.repository")}
								</label>
								<select
									id="review-repository"
									className="w-full rounded border border-vscode-dropdown-border bg-vscode-dropdown-background px-2 py-1.5 text-sm text-vscode-dropdown-foreground"
									value={repositoryPath}
									onChange={(event) => handleRepositoryChange(event.target.value)}>
									{repositories.map((repository) => (
										<option key={repository.path} value={repository.path}>
											{repository.name} — {repository.path}
										</option>
									))}
								</select>
							</>
						)}
						<label className="block text-sm font-medium" htmlFor="review-scope">
							{t("codereview:welcomePage.reviewScope")}
						</label>
						<select
							id="review-scope"
							className="w-full rounded border border-vscode-dropdown-border bg-vscode-dropdown-background px-2 py-1.5 text-sm text-vscode-dropdown-foreground"
							value={scope}
							onChange={(event) => handleScopeChange(event.target.value as ReviewScope)}>
							<option value="uncommitted">{t("codereview:welcomePage.uncommittedChanges")}</option>
							<option value="commit">{t("codereview:welcomePage.specificCommit")}</option>
						</select>
						{scope === "commit" && (
							<div className="space-y-2">
								<input
									className="w-full rounded border border-vscode-input-border bg-vscode-input-background px-2 py-1.5 text-sm text-vscode-input-foreground"
									placeholder={t("codereview:welcomePage.searchCommits")}
									value={commitQuery}
									onChange={(event) => {
										const query = event.target.value
										setCommitQuery(query)
										requestCommits(query)
									}}
								/>
								<select
									className="w-full rounded border border-vscode-dropdown-border bg-vscode-dropdown-background px-2 py-1.5 text-sm text-vscode-dropdown-foreground"
									value={selectedCommit?.hash ?? ""}
									onChange={(event) => handleCommitChange(event.target.value)}>
									<option value="">{t("codereview:welcomePage.selectCommit")}</option>
									{commits.map((commit) => (
										<option key={commit.hash} value={commit.hash}>
											{commit.shortHash} — {commit.subject}
										</option>
									))}
								</select>
								{selectedCommit && (
									<p className="text-xs text-vscode-descriptionForeground">
										{selectedCommit.author} · {selectedCommit.date}
									</p>
								)}
							</div>
						)}
					</div>
					<FileListPreview files={files} isLoading={isLoading} repositoryPath={repositoryPath} />
					<ReviewControlBar
						onStartReview={handleStartReview}
						onRefresh={handleRefresh}
						hasFiles={files.length > 0}
						isLoading={isLoading}
					/>
				</div>
			</div>
		</div>
	)
}

export default WelcomePage
