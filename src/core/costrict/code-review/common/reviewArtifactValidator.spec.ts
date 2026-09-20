import path from "node:path"
import os from "node:os"
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildReviewArtifactCorrectionMessage, validateReviewArtifacts } from "./reviewArtifactValidator"

describe("reviewArtifactValidator", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "costrict-review-artifacts-"))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
	})

	it("accepts fresh normal review JSON and Markdown artifacts", async () => {
		const resultDir = path.join(workspace, "code-review_result")
		await import("node:fs/promises").then(({ mkdir }) => mkdir(resultDir, { recursive: true }))
		await writeFile(path.join(resultDir, "review-report.json"), JSON.stringify({ defects: [] }))
		await writeFile(path.join(resultDir, "review-report.md"), "# Review\n\nNo defects.")

		const result = await validateReviewArtifacts({ workspace, mode: "review", startedAt: Date.now() - 1_000 })

		expect(result).toEqual({ valid: true, errors: [], recovered: [] })
	})

	it("uses the security review artifact contract", async () => {
		const resultDir = path.join(workspace, "security-review_result")
		await import("node:fs/promises").then(({ mkdir }) => mkdir(resultDir, { recursive: true }))
		await writeFile(path.join(resultDir, "review-report.json"), JSON.stringify({ defects: [] }))
		await writeFile(path.join(resultDir, "task_summary.md"), "# Security review\n\nNo defects.")

		const result = await validateReviewArtifacts({
			workspace,
			mode: "security-review",
			startedAt: Date.now() - 1_000,
		})

		expect(result.valid).toBe(true)
	})

	it("normalizes fresh report.json and report.md aliases", async () => {
		const resultDir = path.join(workspace, "code-review_result")
		await import("node:fs/promises").then(({ mkdir }) => mkdir(resultDir, { recursive: true }))
		await writeFile(path.join(resultDir, "report.json"), JSON.stringify({ defects: [] }))
		await writeFile(path.join(resultDir, "report.md"), "# Review\n\nRecovered.")

		const result = await validateReviewArtifacts({ workspace, mode: "review", startedAt: Date.now() - 1_000 })

		expect(result.valid).toBe(true)
		expect(result.recovered).toHaveLength(2)
		await expect(access(path.join(resultDir, "review-report.json"))).resolves.toBeUndefined()
		await expect(access(path.join(resultDir, "review-report.md"))).resolves.toBeUndefined()
	})

	it("prefers fresh aliases over stale canonical artifacts", async () => {
		const resultDir = path.join(workspace, "code-review_result")
		await import("node:fs/promises").then(({ mkdir }) => mkdir(resultDir, { recursive: true }))
		const canonicalJson = path.join(resultDir, "review-report.json")
		const canonicalMarkdown = path.join(resultDir, "review-report.md")
		await writeFile(canonicalJson, JSON.stringify({ run: "old" }))
		await writeFile(canonicalMarkdown, "# Old review")
		const oldTime = new Date("2020-01-01T00:00:00Z")
		await utimes(canonicalJson, oldTime, oldTime)
		await utimes(canonicalMarkdown, oldTime, oldTime)
		await writeFile(path.join(resultDir, "report.json"), JSON.stringify({ run: "new" }))
		await writeFile(path.join(resultDir, "report.md"), "# New review")

		const result = await validateReviewArtifacts({ workspace, mode: "review", startedAt: Date.now() - 1_000 })

		expect(result.valid).toBe(true)
		expect(result.recovered).toHaveLength(2)
	})

	it("rejects invalid JSON", async () => {
		const resultDir = path.join(workspace, "code-review_result")
		await import("node:fs/promises").then(({ mkdir }) => mkdir(resultDir, { recursive: true }))
		await writeFile(path.join(resultDir, "review-report.json"), "{ invalid")
		await writeFile(path.join(resultDir, "review-report.md"), "# Review")

		const result = await validateReviewArtifacts({ workspace, mode: "review", startedAt: Date.now() - 1_000 })

		expect(result.valid).toBe(false)
		expect(result.errors.join("\n")).toContain("JSON 评审文件格式无效")
	})

	it("rejects artifacts left by an earlier task", async () => {
		const resultDir = path.join(workspace, "code-review_result")
		await import("node:fs/promises").then(({ mkdir }) => mkdir(resultDir, { recursive: true }))
		const jsonPath = path.join(resultDir, "review-report.json")
		const markdownPath = path.join(resultDir, "review-report.md")
		await writeFile(jsonPath, JSON.stringify({ defects: [] }))
		await writeFile(markdownPath, "# Old review")
		const oldTime = new Date("2020-01-01T00:00:00Z")
		await utimes(jsonPath, oldTime, oldTime)
		await utimes(markdownPath, oldTime, oldTime)

		const result = await validateReviewArtifacts({ workspace, mode: "review", startedAt: Date.now() })

		expect(result.valid).toBe(false)
		expect(result.errors).toHaveLength(2)
		expect(result.errors.every((error) => error.includes("不是本次任务生成"))).toBe(true)
	})

	it("builds an actionable correction message", () => {
		const message = buildReviewArtifactCorrectionMessage(
			"review",
			{ valid: false, errors: ["缺少 JSON"], recovered: [] },
			2,
		)

		expect(message).toContain("第 2 次")
		expect(message).toContain("code-review_result/review-report.json")
		expect(message).toContain("code-review_result/review-report.md")
		expect(message).toContain("不要重新执行代码分析")
	})

	it("changes the guidance after the correction limit is reached", () => {
		const message = buildReviewArtifactCorrectionMessage(
			"review",
			{ valid: false, errors: ["缺少 JSON"], recovered: [] },
			3,
		)

		expect(message).toContain("已达到自动纠正提示上限")
		expect(message).toContain("请勿再次调用 attempt_completion")
	})
})
