import path from "node:path"

import type { Mode } from "../../../../shared/modes"

export const CODE_REVIEW_RESULT_DIR = "code-review_result"
export const SECURITY_REVIEW_RESULT_DIR = "security-review_result"
export const REVIEW_REPORT_JSON = "review-report.json"
export const REVIEW_REPORT_MD = "review-report.md"
export const SECURITY_REPORT_MD = "task_summary.md"
export const FULL_REPORT_JSONL = "full_report.jsonl"

export function getReviewResultDir(mode: Mode): string {
	return mode === "security-review" ? SECURITY_REVIEW_RESULT_DIR : CODE_REVIEW_RESULT_DIR
}

export function getReviewReportJsonPath(cwd: string, mode: Mode): string {
	return path.resolve(cwd, getReviewResultDir(mode), REVIEW_REPORT_JSON)
}

export function getReviewReportMdPath(cwd: string, mode: Mode): string {
	const fileName = mode === "security-review" ? SECURITY_REPORT_MD : REVIEW_REPORT_MD
	return path.resolve(cwd, getReviewResultDir(mode), fileName)
}

export function getFullReportJsonlPath(cwd: string, mode: Mode): string {
	return path.resolve(cwd, getReviewResultDir(mode), FULL_REPORT_JSONL)
}

export function getReviewReportJsonRelativePath(mode: Mode): string {
	return `${getReviewResultDir(mode)}/${REVIEW_REPORT_JSON}`
}

export function getReviewReportMdRelativePath(mode: Mode): string {
	const fileName = mode === "security-review" ? SECURITY_REPORT_MD : REVIEW_REPORT_MD
	return `${getReviewResultDir(mode)}/${fileName}`
}
