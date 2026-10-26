import { beforeEach, describe, expect, it, vi } from "vitest"

const createDirectoryMock = vi.fn()
const joinPathMock = vi.fn((uri: { path: string }, relativePath: string) => ({
	path: `${uri.path}/${relativePath}`,
	fsPath: `${uri.path}/${relativePath}`,
}))
const sendContextToCloudWithFocusMock = vi.fn()
const startWatchingMock = vi.fn()

vi.mock("vscode", () => ({
	workspace: {
		fs: { createDirectory: (...args: any[]) => createDirectoryMock(...args) },
	},
	Uri: {
		joinPath: (uri: { path: string }, relativePath: string) => joinPathMock(uri, relativePath),
	},
}))

vi.mock("../../../cs-cloud/extension/contextBridge", () => ({
	sendContextToCloudWithFocus: (...args: any[]) => sendContextToCloudWithFocusMock(...args),
}))

vi.mock("../cloudReviewReportWatcher", () => ({
	startWatching: (...args: any[]) => startWatchingMock(...args),
	stopWatching: vi.fn(),
}))

vi.mock("../../../../utils/git", () => ({ getChangedFiles: vi.fn() }))
vi.mock("../../../../utils/path", () => ({ toRelativePath: vi.fn() }))
vi.mock("../../../../i18n", () => ({ t: vi.fn((key: string) => key) }))
vi.mock("../common/reviewContext", () => ({}))
vi.mock("../common/reviewIssueResolver", () => ({
	getReviewReportJsonRelativePath: vi.fn((mode: string) =>
		mode === "security-review"
			? "security-review_result/review-report.json"
			: "code-review_result/review-report.json",
	),
	getReviewReportMdRelativePath: vi.fn((mode: string) =>
		mode === "security-review" ? "security-review_result/task_summary.md" : "code-review_result/review-report.md",
	),
}))

import { CloudReviewController } from "./cloudReviewController"

describe("CloudReviewController result directory initialization", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		createDirectoryMock.mockResolvedValue(undefined)
		sendContextToCloudWithFocusMock.mockResolvedValue("sent")
	})

	it("creates the report directory before watching and sending", async () => {
		const controller = new CloudReviewController()
		const workspaceFolder = { uri: { path: "/workspace", fsPath: "/workspace" } }

		await (controller as any).sendCloudReviewPayload(
			{ type: "assistantUIContext" },
			workspaceFolder,
			"code-review_result/review-report.md",
		)

		expect(joinPathMock).toHaveBeenCalledWith(workspaceFolder.uri, "code-review_result")
		expect(createDirectoryMock).toHaveBeenCalledWith({
			path: "/workspace/code-review_result",
			fsPath: "/workspace/code-review_result",
		})
		expect(createDirectoryMock.mock.invocationCallOrder[0]).toBeLessThan(
			startWatchingMock.mock.invocationCallOrder[0],
		)
		expect(startWatchingMock.mock.invocationCallOrder[0]).toBeLessThan(
			sendContextToCloudWithFocusMock.mock.invocationCallOrder[0],
		)
	})

	it("does not start watching or send when directory creation fails", async () => {
		const controller = new CloudReviewController()
		const workspaceFolder = { uri: { path: "/workspace", fsPath: "/workspace" } }
		createDirectoryMock.mockRejectedValueOnce(new Error("read-only workspace"))

		await expect(
			(controller as any).sendCloudReviewPayload(
				{ type: "assistantUIContext" },
				workspaceFolder,
				"security-review_result/task_summary.md",
			),
		).rejects.toThrow("read-only workspace")

		expect(startWatchingMock).not.toHaveBeenCalled()
		expect(sendContextToCloudWithFocusMock).not.toHaveBeenCalled()
	})
})
