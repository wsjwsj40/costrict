import type { ModelRecord } from "@roo-code/types"

export function isForbiddenModelRequest(error: any): boolean {
	const statuses = [
		error?.status,
		error?.statusCode,
		error?.response?.status,
		error?.response?.statusCode,
		error?.cause?.status,
		error?.cause?.statusCode,
	]
	if (statuses.some((status) => Number(status) === 403)) return true

	const message = [error?.message, error?.error?.message, error?.cause?.message]
		.filter((value): value is string => typeof value === "string")
		.join("\n")
	return /(?:\bcode\s*:\s*|\bstatus(?:Code)?\s*[:=]\s*|\bHTTP\s+)403\b/i.test(message)
}

export function describeModelPermissionError(error: any): string {
	return JSON.stringify({
		name: error?.name,
		status: error?.status,
		statusCode: error?.statusCode,
		code: error?.code,
		responseStatus: error?.response?.status,
		causeStatus: error?.cause?.status,
		message: error?.message,
	})
}

export function selectPermissionReplacementModel(models: ModelRecord, currentModel?: string): string | undefined {
	const modelIds = Object.keys(models)
	if (modelIds.length === 0 || (currentModel && modelIds.includes(currentModel))) return undefined
	return modelIds[0]
}
