import { ModelInfo } from "../model.js"

// Costrict models are supplied dynamically by the permission-filtered model
// service; there is no client-side synthetic default model.
export const costrictDefaultModelId = ""

export const costrictModelsConfig = {
	default: {
		maxTokens: 8192,
		contextWindow: 128_000,
		maxTokensKey: undefined,
		supportsImages: false,
		supportsNativeTools: undefined,
		supportsComputerUse: false,
		supportsPromptCache: true,
		supportsReasoningBudget: false,
		requiredReasoningBudget: false,
		minTokensPerCachePoint: undefined,
		maxCachePoints: undefined,
		cachableFields: undefined,
		description: undefined,
	} as ModelInfo,
} as const satisfies Record<string, ModelInfo>
