/**
 * Review Issue Resolver
 *
 * Small shared module for review report artifacts. It intentionally keeps the
 * related helpers together to avoid scattering tiny files across common/:
 * - report path constants/builders
 * - review API request option builder
 * - report file/text -> issue resolution
 *
 * Used by both classic (CodeReviewService) and cloud (report watcher) paths.
 */

import path from "node:path"
import { mkdir, readFile, readdir, rename } from "node:fs/promises"
import type { AxiosRequestConfig } from "axios"
import { v7 as uuidv7 } from "uuid"

import type { ReviewTarget, ReviewIssue } from "../../../../shared/codeReview"
import type { Mode } from "../../../../shared/modes"
import { COSTRICT_DEFAULT_HEADERS } from "../../../../shared/headers"
import { getClientId } from "../../../../utils/getClientId"
import { reportIssue } from "../api"
import { getReviewResultDir } from "./reviewArtifactPaths"

export {
	CODE_REVIEW_RESULT_DIR,
	SECURITY_REVIEW_RESULT_DIR,
	REVIEW_REPORT_JSON,
	REVIEW_REPORT_MD,
	SECURITY_REPORT_MD,
	FULL_REPORT_JSONL,
	getReviewReportJsonPath,
	getReviewReportMdPath,
	getFullReportJsonlPath,
	getReviewReportJsonRelativePath,
	getReviewReportMdRelativePath,
} from "./reviewArtifactPaths"

// ── Report paths ───────────────────────────────────────────────────────

/**
 * Prepare a clean report directory before a review task starts.
 *
 * Existing reports, aliases, and drafts are preserved under history/<run-id>
 * so a new model run cannot accidentally consume stale artifacts. The history
 * directory itself is never nested into a later archive.
 */
export async function ensureReviewResultDirectory(cwd: string, mode: Mode): Promise<string> {
	const resultDir = path.resolve(cwd, getReviewResultDir(mode))
	await mkdir(resultDir, { recursive: true })

	const entries = (await readdir(resultDir)).filter((entry) => entry !== "history")
	if (entries.length === 0) return resultDir

	const archiveId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${uuidv7()}`
	const archiveDir = path.join(resultDir, "history", archiveId)
	await mkdir(archiveDir, { recursive: true })

	for (const entry of entries) {
		await rename(path.join(resultDir, entry), path.join(archiveDir, entry))
	}

	return resultDir
}

// ── Request options ────────────────────────────────────────────────────

export interface ReviewRequestOptionsInput {
	/** API access token (costrictAccessToken from provider state) */
	apiKey: string
	/** API base URL */
	baseURL: string
	/** Language for Accept-Language header (e.g. "en", "zh-CN") */
	language: string
}

export function buildReviewRequestOptions(input: ReviewRequestOptionsInput): AxiosRequestConfig {
	return {
		baseURL: input.baseURL,
		headers: {
			Authorization: `Bearer ${input.apiKey}`,
			"Accept-Language": input.language,
			"X-Request-ID": uuidv7(),
			...COSTRICT_DEFAULT_HEADERS,
		},
		timeout: 10 * 60 * 1000,
	}
}

// ── Issue resolution ───────────────────────────────────────────────────

export interface ResolveInput {
	/** Source identifier for the reportIssue API */
	source: "classic" | "cloud"
	/** The review target (file, folder, code, commit) */
	reviewTarget: ReviewTarget
	/** Workspace root path (Posix) */
	workspace: string
	/** Axios request config for the reportIssue API call */
	requestOptions: AxiosRequestConfig
}

export interface ResolveResult {
	/** Resolved issues from the API */
	issues: ReviewIssue[]
	/** Review task ID from the API */
	review_task_id: string
	/** Number of issues reported */
	count: number
	/** Review title from the API */
	title: string
	/** Review conclusion from the API */
	conclusion: string
	/** Path to the report file, if resolved from file */
	reportPath?: string
}

function emptyResult(): ResolveResult {
	return {
		issues: [],
		review_task_id: "",
		count: 0,
		title: "",
		conclusion: "",
	}
}

/**
 * Read a JSON report file from disk and resolve issues via the reportIssue API.
 *
 * This helper never throws. It returns an empty result on any read/API error so
 * callers can decide whether to fallback or surface an error.
 */
export async function resolveFromReportFile(jsonPath: string, input: ResolveInput): Promise<ResolveResult> {
	try {
		const content = await readFile(jsonPath, "utf-8")
		const result = await resolveFromReportText(content, input)
		return { ...result, reportPath: jsonPath }
	} catch (error) {
		console.error("[resolveFromReportFile] Failed:", error)
		return emptyResult()
	}
}

/**
 * Call the reportIssue API directly with a raw report text string.
 *
 * Used by the classic path as a fallback when the JSON report file is not
 * available (e.g. report text comes from in-memory clineMessages or the
 * legacy full_report.jsonl file).
 */
export async function resolveFromReportText(reportText: string, input: ResolveInput): Promise<ResolveResult> {
	try {
		const clientId = getClientId()
		const { data } = await reportIssue(
			{
				review_report: reportText,
				client_id: clientId,
				workspace: input.workspace,
				source: input.source,
				review_target: input.reviewTarget,
			},
			input.requestOptions,
		)
		return data ?? emptyResult()
	} catch (error) {
		console.error("[resolveFromReportText] Failed:", error)
		return emptyResult()
	}
}
