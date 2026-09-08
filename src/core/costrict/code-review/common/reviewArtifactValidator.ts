import path from "node:path"
import { copyFile, readFile, stat } from "node:fs/promises"

import type { Mode } from "../../../../shared/modes"
import { getReviewReportJsonPath, getReviewReportMdPath } from "./reviewArtifactPaths"

const MIN_REPORT_BYTES = 2

export interface ReviewArtifactValidationInput {
	workspace: string
	mode: Mode
	startedAt: number
}

export interface ReviewArtifactValidationResult {
	valid: boolean
	errors: string[]
	recovered: Array<{ from: string; to: string }>
}

interface ArtifactSpec {
	kind: "JSON" | "Markdown"
	expectedPath: string
	aliases: string[]
}

async function validateFreshFile(
	filePath: string,
	startedAt: number,
	kind: ArtifactSpec["kind"],
): Promise<string | null> {
	let fileStat
	try {
		fileStat = await stat(filePath)
	} catch {
		return `缺少 ${kind} 评审文件：${filePath}`
	}

	if (!fileStat.isFile()) return `${kind} 评审产物不是普通文件：${filePath}`
	if (fileStat.size < MIN_REPORT_BYTES) return `${kind} 评审文件为空：${filePath}`
	if (fileStat.mtimeMs < startedAt) return `${kind} 评审文件不是本次任务生成的：${filePath}`

	let content: string
	try {
		content = await readFile(filePath, "utf-8")
	} catch (error) {
		return `无法读取 ${kind} 评审文件 ${filePath}：${error instanceof Error ? error.message : String(error)}`
	}

	if (!content.trim()) return `${kind} 评审文件为空：${filePath}`
	if (kind === "JSON") {
		try {
			const parsed = JSON.parse(content)
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return `JSON 评审文件顶层必须是对象：${filePath}`
			}
		} catch (error) {
			return `JSON 评审文件格式无效 ${filePath}：${error instanceof Error ? error.message : String(error)}`
		}
	}

	return null
}

async function recoverAlias(spec: ArtifactSpec, startedAt: number): Promise<{ from: string; to: string } | null> {
	for (const alias of spec.aliases) {
		if ((await validateFreshFile(alias, startedAt, spec.kind)) !== null) continue
		await copyFile(alias, spec.expectedPath)
		return { from: alias, to: spec.expectedPath }
	}
	return null
}

function getArtifactSpecs(workspace: string, mode: Mode): ArtifactSpec[] {
	const resultDir = path.dirname(getReviewReportJsonPath(workspace, mode))
	return [
		{
			kind: "JSON",
			expectedPath: getReviewReportJsonPath(workspace, mode),
			aliases: [path.join(resultDir, "report.json"), path.join(resultDir, "review.json")],
		},
		{
			kind: "Markdown",
			expectedPath: getReviewReportMdPath(workspace, mode),
			aliases: [path.join(resultDir, "report.md"), path.join(resultDir, "review.md")],
		},
	]
}

/** Validate the final artifacts for the current review run and normalize safe aliases. */
export async function validateReviewArtifacts(
	input: ReviewArtifactValidationInput,
): Promise<ReviewArtifactValidationResult> {
	const errors: string[] = []
	const recovered: Array<{ from: string; to: string }> = []

	for (const spec of getArtifactSpecs(input.workspace, input.mode)) {
		let error = await validateFreshFile(spec.expectedPath, input.startedAt, spec.kind)
		if (error) {
			try {
				const recovery = await recoverAlias(spec, input.startedAt)
				if (recovery) {
					recovered.push(recovery)
					error = await validateFreshFile(spec.expectedPath, input.startedAt, spec.kind)
				}
			} catch (recoveryError) {
				error = `无法将 ${spec.kind} 兼容文件规范化到 ${spec.expectedPath}：${
					recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
				}`
			}
		}
		if (error) errors.push(error)
	}

	return { valid: errors.length === 0, errors, recovered }
}

export function buildReviewArtifactCorrectionMessage(
	mode: Mode,
	result: ReviewArtifactValidationResult,
	attempt: number,
): string {
	const jsonPath =
		mode === "security-review"
			? "security-review_result/review-report.json"
			: "code-review_result/review-report.json"
	const markdownPath =
		mode === "security-review" ? "security-review_result/task_summary.md" : "code-review_result/review-report.md"

	return [
		`Code Review 产物校验未通过（第 ${attempt} 次），暂时不能完成任务。`,
		...(attempt >= 3 ? ["已达到自动纠正提示上限；在文件校验通过前，请勿再次调用 attempt_completion。"] : []),
		"",
		...result.errors.map((error) => `- ${error}`),
		"",
		"请不要重新执行代码分析，直接复用当前评审结果完成以下操作：",
		`1. 将结构化报告写入 \`${jsonPath}\`；`,
		`2. 将用户可读报告写入 \`${markdownPath}\`；`,
		"3. 使用 read_file 重新读取并验证两个文件；",
		"4. 确认 JSON 是完整对象后，再次调用 attempt_completion。",
		"",
		"仅在对话或 attempt_completion.result 中输出报告不能替代文件产物。",
	].join("\n")
}
