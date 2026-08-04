import type { ModelRecord } from "@roo-code/types"

export function isForbiddenModelRequest(error: any): boolean {
	return [error?.status, error?.response?.status, error?.cause?.status].some((status) => Number(status) === 403)
}

export function selectPermissionReplacementModel(models: ModelRecord, currentModel?: string): string | undefined {
	const modelIds = Object.keys(models)
	if (modelIds.length === 0 || (currentModel && modelIds.includes(currentModel))) return undefined
	return modelIds[0]
}
