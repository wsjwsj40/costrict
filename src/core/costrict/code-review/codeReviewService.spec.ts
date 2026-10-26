import { EventEmitter } from "node:events"
import path from "node:path"
import { readFile } from "node:fs/promises"

import { RooCodeEventName } from "@roo-code/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { IssueStatus, ReviewTargetType, ReviewTaskStatus } from "../../../shared/codeReview"
import { fileExistsAtPath } from "../../../utils/fs"
import { getIssueByTaskId } from "./api"
import { parseLocalReviewReport } from "./common/localReviewReport"
import { CodeReviewService } from "./codeReviewService"

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	readFile: vi.fn().mockResolvedValue("# Review\n\nNo issues found"),
}))

vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	workspace: {
		applyEdit: vi.fn().mockResolvedValue(true),
	},
	Uri: {
		joinPath: vi.fn((...parts: Array<{ fsPath?: string } | string>) => ({
			fsPath: parts.map((part) => (typeof part === "string" ? part : (part.fsPath ?? ""))).join("/"),
		})),
		file: vi.fn((fsPath: string) => ({ fsPath })),
	},
	MarkdownString: class {
		constructor(public value: string) {}
	},
	CommentMode: {
		Preview: 0,
	},
	Range: class {
		constructor(..._args: any[]) {}
	},
	WorkspaceEdit: class {
		replace = vi.fn()
	},
}))

vi.mock("./HistoryManager", () => ({
	HistoryManager: class {
		addEntry = vi.fn().mockResolvedValue(undefined)
		getLocalIssues = vi.fn().mockResolvedValue(null)
		loadAll = vi.fn().mockResolvedValue([])
		deleteEntry = vi.fn().mockResolvedValue(undefined)
		dispose = vi.fn().mockResolvedValue(undefined)
	},
}))

vi.mock("./api", () => ({
	updateIssueStatusAPI: vi.fn(),
	getPrompt: vi.fn(),
	reportIssue: vi.fn(),
	getIssueByTaskId: vi.fn(),
}))

vi.mock("../../../utils/logger", () => ({
	createLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		dispose: vi.fn(),
		channel: {
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		},
	})),
}))

vi.mock("../../../utils/getClientId", () => ({
	getClientId: vi.fn(() => "client-1"),
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("../../../shared/package", () => ({
	Package: {
		outputChannel: {},
	},
}))

vi.mock("../auth", () => ({
	CostrictAuthConfig: {
		getInstance: vi.fn(() => ({
			getDefaultApiBaseUrl: vi.fn(() => "https://example.test"),
		})),
	},
	CostrictAuthService: {
		openStatusBarLoginTip: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("../../../integrations/comment", () => ({
	CommentService: class {},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureError: vi.fn(),
		},
	},
}))

vi.mock("../../../shared/headers", () => ({
	COSTRICT_DEFAULT_HEADERS: {},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../utils/platform", () => ({
	isJetbrainsPlatform: vi.fn(() => false),
}))

vi.mock("./reviewComment", () => ({
	ReviewComment: class {},
}))

// Mock common review modules used by CodeReviewService
const resolveFromReportFileMock = vi.fn()
const resolveFromReportTextMock = vi.fn()
const buildReviewRequestOptionsMock = vi.fn()
const ensureReviewResultDirectoryMock = vi.fn()

vi.mock("./common/reviewIssueResolver", () => ({
	buildReviewRequestOptions: (...args: any[]) => buildReviewRequestOptionsMock(...args),
	ensureReviewResultDirectory: (...args: any[]) => ensureReviewResultDirectoryMock(...args),
	getReviewReportJsonPath: vi.fn((cwd: string, _mode: string) => `${cwd}/code-review_result/review-report.json`),
	getReviewReportMdPath: vi.fn((cwd: string, _mode: string) => `${cwd}/code-review_result/review-report.md`),
	getFullReportJsonlPath: vi.fn((cwd: string, _mode: string) => `${cwd}/code-review_result/full_report.jsonl`),
	resolveFromReportFile: (...args: any[]) => resolveFromReportFileMock(...args),
	resolveFromReportText: (...args: any[]) => resolveFromReportTextMock(...args),
}))

// Default: resolveFromReportFile returns empty (overridden per test)
resolveFromReportFileMock.mockResolvedValue({
	issues: [],
	review_task_id: "",
	count: 0,
	title: "",
	conclusion: "",
})

// Default: buildReviewRequestOptions returns empty config
buildReviewRequestOptionsMock.mockReturnValue({})

class FakeTask extends EventEmitter {
	public readonly clineMessages: any[] = []
	public taskAsk?: { ask: string }
	public readonly updateMode = vi.fn()

	constructor(
		public readonly taskId: string,
		public readonly instanceId: string,
	) {
		super()
	}
}

class FakeProvider extends EventEmitter {
	public readonly cwd = "/workspace"
	public readonly contextProxy = { extensionUri: { fsPath: "/extension" } }
	public readonly postMessageToWebview = vi.fn()
	public readonly createTask = vi.fn<(...args: any[]) => Promise<FakeTask>>()
	public readonly getMode = vi.fn(async () => "code")
	public readonly handleModeSwitch = vi.fn(async () => undefined)
	public readonly removeClineFromStack = vi.fn(async () => undefined)
	public readonly refreshWorkspace = vi.fn(async () => undefined)
	public readonly getState = vi.fn(async () => ({
		apiConfiguration: {
			costrictAccessToken: "test-token",
			costrictBaseUrl: "https://example.test",
		},
		language: "en",
	}))
	public readonly getCurrentTask = vi.fn<() => FakeTask | undefined>()
}

function getReviewUpdates(provider: FakeProvider) {
	return provider.postMessageToWebview.mock.calls
		.map(([message]) => message)
		.filter((message) => message?.type === "reviewTaskUpdate")
}

describe("CodeReviewService delegation lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		vi.mocked(readFile).mockResolvedValue("# Review\n\nNo issues found")
		;(CodeReviewService as any).instance = null
		ensureReviewResultDirectoryMock.mockResolvedValue("/workspace/code-review_result")
	})

	afterEach(async () => {
		const instance = (CodeReviewService as any).instance as CodeReviewService | null
		await instance?.dispose()
		;(CodeReviewService as any).instance = null
		vi.useRealTimers()
	})

	it.each(["review", "security-review"] as const)(
		"initializes the %s result directory before starting the model task",
		async (mode) => {
			const provider = new FakeProvider()
			const task = new FakeTask(`task-${mode}`, `instance-${mode}`)
			provider.createTask.mockResolvedValue(task)
			provider.getCurrentTask.mockReturnValue(task)

			const service = CodeReviewService.getInstance()
			service.setProvider(provider as any)
			await service.createReviewTask("review this", { type: ReviewTargetType.FILE, data: [] }, { mode })

			expect(ensureReviewResultDirectoryMock).toHaveBeenCalledWith("/workspace", mode)
			expect(ensureReviewResultDirectoryMock.mock.invocationCallOrder[0]).toBeLessThan(
				provider.handleModeSwitch.mock.invocationCallOrder[0],
			)
			expect(provider.createTask).toHaveBeenCalledTimes(1)
		},
	)

	it("does not start a review task when the result directory cannot be created", async () => {
		const provider = new FakeProvider()
		ensureReviewResultDirectoryMock.mockRejectedValueOnce(new Error("EACCES: permission denied"))

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)
		await service.createReviewTask("review this", { type: ReviewTargetType.FILE, data: [] })

		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
		const updates = getReviewUpdates(provider)
		expect(updates.at(-1)).toMatchObject({
			values: {
				status: ReviewTaskStatus.ERROR,
				data: { error: "EACCES: permission denied" },
			},
		})
	})

	it("keeps the review alive across delegated subtasks and completes on the resumed root task", async () => {
		const provider = new FakeProvider()
		const rootTask = new FakeTask("review-root", "inst-root")
		let currentTask: FakeTask | undefined = rootTask

		provider.createTask.mockResolvedValue(rootTask)
		provider.getCurrentTask.mockImplementation(() => currentTask)

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)

		// JSON report exists
		;(fileExistsAtPath as any).mockResolvedValue(true)

		resolveFromReportFileMock.mockResolvedValue({
			issues: [
				{
					id: "issue-1",
					file_path: "src/a.ts",
					start_line: 1,
					end_line: 1,
					title: "Issue",
					message: "Problem found",
					status: IssueStatus.INITIAL,
				},
			],
			review_task_id: "review-task-1",
			count: 1,
			title: "Security review",
			conclusion: "Done",
		})

		await service.createReviewTask(
			"@/src/a.ts",
			{
				type: ReviewTargetType.FILE,
				data: [{ file_path: "src/a.ts" }],
			} as any,
			{ mode: "security-review" },
		)

		rootTask.emit(RooCodeEventName.TaskAborted)
		provider.emit(RooCodeEventName.TaskDelegated, "review-root", "child-1")
		await vi.advanceTimersByTimeAsync(350)

		expect(
			getReviewUpdates(provider).some(
				(update) =>
					update.values.status === ReviewTaskStatus.ERROR &&
					update.values.data.error === "common:review.tip.task_cancelled",
			),
		).toBe(false)

		const resumedTask = new FakeTask("review-root", "inst-root-2")
		resumedTask.clineMessages.push({
			type: "say",
			say: "completion_result",
			text: "I-AM-CODE-REVIEW-REPORT-V1 final report",
			partial: false,
		})
		currentTask = resumedTask

		provider.emit(RooCodeEventName.TaskCreated, resumedTask as any)
		provider.emit(RooCodeEventName.TaskDelegationResumed, "review-root", "child-1")
		resumedTask.emit(RooCodeEventName.Message, {
			message: resumedTask.clineMessages[0],
		})

		await vi.runAllTimersAsync()

		// JSON file existence was checked (the primary path)
		expect(fileExistsAtPath).toHaveBeenCalledWith(
			path.resolve("/workspace", "code-review_result/review-report.json"),
		)

		const reviewUpdates = getReviewUpdates(provider)
		expect(
			reviewUpdates.some(
				(update) =>
					update.values.status === ReviewTaskStatus.ERROR &&
					update.values.data.error === "common:review.tip.task_cancelled",
			),
		).toBe(false)

		const finalUpdate = reviewUpdates.at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.COMPLETED)
		expect(finalUpdate?.values.data.error).toBeUndefined()
		expect(finalUpdate?.values.data.issues).toHaveLength(1)
		expect(provider.removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(resumedTask.updateMode).toHaveBeenCalledWith("code")
	})

	it("resolves issues from review-report.json via the primary path", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-json", "inst-json")

		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockImplementation(() => task)

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)

		// JSON report exists
		;(fileExistsAtPath as any).mockResolvedValue(true)

		resolveFromReportFileMock.mockResolvedValue({
			issues: [
				{
					id: "json-issue-1",
					file_path: "src/json-file.ts",
					start_line: 5,
					end_line: 10,
					title: "JSON Issue",
					message: "Found via JSON",
					status: IssueStatus.INITIAL,
				},
			],
			review_task_id: "json-task-1",
			count: 1,
			title: "JSON Review",
			conclusion: "JSON-based",
		})

		await service.createReviewTask(
			"@/src/json-file.ts",
			{
				type: ReviewTargetType.FILE,
				data: [{ file_path: "src/json-file.ts" }],
			} as any,
			{ mode: "review" },
		)

		// Simulate task completion via completion_result message
		task.clineMessages.push({
			type: "say",
			say: "completion_result",
			text: "I-AM-CODE-REVIEW-REPORT-V1 legacy report",
			partial: false,
		})
		task.emit(RooCodeEventName.Message, {
			message: task.clineMessages[0],
		})

		await vi.runAllTimersAsync()

		// Should have called resolveFromReportFile with the JSON path
		expect(resolveFromReportFileMock).toHaveBeenCalledTimes(1)
		// Should NOT have called resolveFromReportText (no fallback used)
		expect(resolveFromReportTextMock).not.toHaveBeenCalled()

		const issues = service.getAllCachedIssues()
		expect(issues).toHaveLength(1)
		expect(issues[0].id).toBe("json-issue-1")

		const reviewUpdates = getReviewUpdates(provider)
		const finalUpdate = reviewUpdates.at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.COMPLETED)
		expect(finalUpdate?.values.data.issues).toHaveLength(1)
	})

	it("keeps a review running while an API failure waits for retry in chat", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-retry", "inst-retry")
		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockReturnValue(task)
		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)

		await service.createReviewTask("review this", { type: ReviewTargetType.COMMIT, commit: "abcdef1234567" })
		task.taskAsk = { ask: "api_req_failed" }
		task.emit(RooCodeEventName.TaskIdle)

		let latestUpdate = getReviewUpdates(provider).at(-1)
		expect(latestUpdate?.values.status).toBe(ReviewTaskStatus.RUNNING)
		expect(latestUpdate?.values.data.message).toBe("common:review.tip.retry_in_chat")
		expect(latestUpdate?.values.data.error).toBeUndefined()

		task.taskAsk = undefined
		task.emit(RooCodeEventName.TaskAskResponded)
		latestUpdate = getReviewUpdates(provider).at(-1)
		expect(latestUpdate?.values.data.message).toBeUndefined()
	})

	it("resolves a completed review when only the idle completion event is observed", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-idle-complete", "inst-idle-complete")
		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockReturnValue(task)
		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)
		;(fileExistsAtPath as any).mockResolvedValue(true)
		resolveFromReportFileMock.mockResolvedValue({
			issues: [],
			review_task_id: "resolved-idle-complete",
			count: 0,
			title: "Commit review",
			conclusion: "No issues found",
		})

		await service.createReviewTask("review this", { type: ReviewTargetType.COMMIT, commit: "abcdef1234567" })
		task.taskAsk = { ask: "completion_result" }
		task.emit(RooCodeEventName.TaskIdle)
		await vi.runAllTimersAsync()

		const latestUpdate = getReviewUpdates(provider).at(-1)
		expect(latestUpdate?.values.status).toBe(ReviewTaskStatus.COMPLETED)
		expect(latestUpdate?.values.data.error).toBeUndefined()
	})

	it("keeps historical commit issues when their files no longer exist in the working tree", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-commit", "inst-commit")
		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockImplementation(() => task)

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)
		;(fileExistsAtPath as any)
			.mockResolvedValueOnce(true) // JSON report
			.mockResolvedValueOnce(false) // issue file
			.mockResolvedValueOnce(true) // Markdown report
		resolveFromReportFileMock.mockResolvedValue({
			issues: [
				{
					id: "deleted-file-issue",
					file_path: "src/removed.ts",
					start_line: 3,
					end_line: 3,
					title: "Historical issue",
					message: "Found in the reviewed commit",
					status: IssueStatus.INITIAL,
				},
			],
			review_task_id: "commit-review-task",
			count: 1,
			title: "",
			conclusion: "One issue found",
		})

		await service.createReviewTask(
			"@abcdef1",
			{ type: ReviewTargetType.COMMIT, commit: "abcdef1234567" },
			{ mode: "review" },
		)
		task.clineMessages.push({ type: "say", say: "completion_result", text: "report", partial: false })
		task.emit(RooCodeEventName.Message, { message: task.clineMessages[0] })
		await vi.runAllTimersAsync()

		const issues = service.getAllCachedIssues()
		expect(issues).toHaveLength(1)
		expect(issues[0].location_status).toBe("target-version")
		expect(issues[0].location_reason).toContain("abcdef12")
	})

	it("throws error when review-report.json is not found", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-nofile", "inst-nf")

		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockImplementation(() => task)

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)

		// JSON report does NOT exist
		;(fileExistsAtPath as any).mockResolvedValue(false)

		await service.createReviewTask(
			"@/src/missing.ts",
			{
				type: ReviewTargetType.FILE,
				data: [{ file_path: "src/missing.ts" }],
			} as any,
			{ mode: "review" },
		)

		task.clineMessages.push({
			type: "say",
			say: "completion_result",
			text: "some report text",
			partial: false,
		})
		task.emit(RooCodeEventName.Message, {
			message: task.clineMessages[0],
		})

		await vi.runAllTimersAsync()

		// Should NOT have tried to resolve from file or text
		expect(resolveFromReportFileMock).not.toHaveBeenCalled()
		expect(resolveFromReportTextMock).not.toHaveBeenCalled()

		const reviewUpdates = getReviewUpdates(provider)
		const finalUpdate = reviewUpdates.at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.ERROR)
	})

	it("completes successfully when a valid review report contains no issues", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-empty", "inst-empty")

		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockImplementation(() => task)

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)

		// A successful clean review still has a server-assigned review task id.
		;(fileExistsAtPath as any).mockResolvedValue(true)

		resolveFromReportFileMock.mockResolvedValue({
			issues: [],
			review_task_id: "clean-review-task",
			count: 0,
			title: "Clean review",
			conclusion: "No issues found",
		})

		await service.createReviewTask(
			"@/src/empty.ts",
			{
				type: ReviewTargetType.FILE,
				data: [{ file_path: "src/empty.ts" }],
			} as any,
			{ mode: "review" },
		)

		task.clineMessages.push({
			type: "say",
			say: "completion_result",
			text: "empty report",
			partial: false,
		})
		task.emit(RooCodeEventName.Message, {
			message: task.clineMessages[0],
		})

		await vi.runAllTimersAsync()

		// The empty issue list is a valid result, not a transport/report failure.
		expect(resolveFromReportFileMock).toHaveBeenCalledTimes(1)
		// No fallback to resolveFromReportText
		expect(resolveFromReportTextMock).not.toHaveBeenCalled()

		const reviewUpdates = getReviewUpdates(provider)
		const finalUpdate = reviewUpdates.at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.COMPLETED)
		expect(finalUpdate?.values.data.error).toBeUndefined()
		expect(finalUpdate?.values.data.issues).toEqual([])
		expect(finalUpdate?.values.data.message).toBeUndefined()
		expect(finalUpdate?.values.data.reportPath).toBe("/workspace/code-review_result/review-report.md")
		expect(
			provider.postMessageToWebview.mock.calls.some(
				([message]) => message?.type === "action" && message.action === "codeReviewButtonClicked",
			),
		).toBe(true)
	})

	it.each([
		["summary", "### DiCode评审摘要\n- 安全漏洞：高 1 / 中 5 / 低 2", "# Review\n\nNo issues found"],
		["Markdown", "", "### DiCode评审摘要\n- 安全漏洞：高 1 / 中 5 / 低 2"],
	])("warns instead of claiming a clean review when the %s lists findings", async (_source, conclusion, markdown) => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-mismatch", "inst-mismatch")
		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockReturnValue(task)
		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)
		;(fileExistsAtPath as any).mockResolvedValue(true)
		vi.mocked(readFile).mockResolvedValue(markdown)
		resolveFromReportFileMock.mockResolvedValue({
			issues: [],
			review_task_id: "mismatch-task",
			count: 0,
			title: "Commit review",
			conclusion,
		})

		await service.createReviewTask("@abcdef1", { type: ReviewTargetType.COMMIT, commit: "abcdef1234567" })
		task.clineMessages.push({ type: "say", say: "completion_result", text: "report", partial: false })
		task.emit(RooCodeEventName.Message, { message: task.clineMessages[0] })
		await vi.runAllTimersAsync()

		const finalUpdate = getReviewUpdates(provider).at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.COMPLETED)
		expect(finalUpdate?.values.data.issues).toEqual([])
		expect(finalUpdate?.values.data.message).toBe("common:review.tip.structured_issues_missing")
		expect(finalUpdate?.values.data.reportPath).toBe("/workspace/code-review_result/review-report.md")
		expect(readFile).toHaveBeenCalledTimes(conclusion ? 1 : 2)
	})

	it("recovers report findings when the issue API returns an empty list", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-local-recovery", "inst-local-recovery")
		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockReturnValue(task)
		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)
		;(fileExistsAtPath as any).mockResolvedValue(true)
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				defects: [
					{
						file_path: "src/a.ts",
						line: 4,
						severity: "high",
						title: "First defect",
						description: "First detail",
					},
					{
						file_path: "src/b.ts",
						line: 8,
						severity: "medium",
						title: "Second defect",
						description: "Second detail",
					},
				],
			}),
		)
		resolveFromReportFileMock.mockResolvedValue({
			issues: [],
			review_task_id: "local-recovery-id",
			count: 0,
			title: "",
			conclusion: "高 1 / 中 1",
		})

		await service.createReviewTask("@abcdef1", { type: ReviewTargetType.COMMIT, commit: "abcdef1234567" })
		task.clineMessages.push({ type: "say", say: "completion_result", text: "report", partial: false })
		task.emit(RooCodeEventName.Message, { message: task.clineMessages[0] })
		await vi.runAllTimersAsync()

		const finalUpdate = getReviewUpdates(provider).at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.COMPLETED)
		expect(finalUpdate?.values.data.issues).toHaveLength(2)
		expect(finalUpdate?.values.data.issues[0]).toMatchObject({
			source: "local-report",
			title: "First defect",
			message: "First detail",
			location_status: "current",
		})
		expect(finalUpdate?.values.data.message).toBe("common:review.tip.local_issues_recovered")
		expect((service as any).historyManager.addEntry).toHaveBeenCalledWith(
			"local-recovery-id",
			"Code Review · abcdef12",
			"高 1 / 中 1",
			finalUpdate?.values.data.issues,
		)
	})

	it("loads persisted local findings when historical issue lookup returns fewer results", async () => {
		const service = CodeReviewService.getInstance()
		const recoveredIssue = parseLocalReviewReport(
			JSON.stringify({ defects: [{ file_path: "src/a.ts", line: 4, message: "Persisted finding" }] }),
			"historical-task",
		)![0]
		;(service as any).historyManager.getLocalIssues.mockResolvedValue([recoveredIssue])
		vi.mocked(getIssueByTaskId).mockResolvedValue({ success: true, data: { issues: [] } } as any)

		await expect(service.getReviewHistoryById("historical-task")).resolves.toEqual({ issues: [recoveredIssue] })
	})

	it("reports an error when resolving the report fails without a review task id", async () => {
		const provider = new FakeProvider()
		const task = new FakeTask("review-invalid", "inst-invalid")

		provider.createTask.mockResolvedValue(task)
		provider.getCurrentTask.mockImplementation(() => task)

		const service = CodeReviewService.getInstance()
		service.setProvider(provider as any)
		;(fileExistsAtPath as any).mockResolvedValue(true)
		resolveFromReportFileMock.mockResolvedValue({
			issues: [],
			review_task_id: "",
			count: 0,
			title: "",
			conclusion: "",
		})

		await service.createReviewTask(
			"@/src/invalid.ts",
			{
				type: ReviewTargetType.FILE,
				data: [{ file_path: "src/invalid.ts" }],
			} as any,
			{ mode: "review" },
		)

		task.emit(RooCodeEventName.TaskCompleted)
		await vi.runAllTimersAsync()

		const finalUpdate = getReviewUpdates(provider).at(-1)
		expect(finalUpdate?.values.status).toBe(ReviewTaskStatus.ERROR)
		expect(finalUpdate?.values.data.error).toBe("common:review.tip.get_review_result_failed")
	})
})
