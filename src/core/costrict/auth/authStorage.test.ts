import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("jwt-decode", () => ({
	jwtDecode: vi.fn(() => ({
		exp: 2_000_000_000,
		iat: 1_000_000_000,
	})),
}))

vi.mock("./ipc/client", () => ({
	sendCostrictTokens: vi.fn(),
}))

vi.mock("../runtime-config", () => ({
	clearCostrictRuntimeAuth: vi.fn().mockResolvedValue(undefined),
	ensureCompletionRuntimeReady: vi.fn().mockResolvedValue(undefined),
	writeCostrictRuntimeAuth: vi.fn().mockResolvedValue(undefined),
	ensureCostrictRuntimeInstalled: vi.fn().mockResolvedValue("noUpdate"),
	getRuntimeBinaryPath: vi.fn(() => "/tmp/home/.costrict/bin/costrict"),
	getRuntimeProcessName: vi.fn(() => "costrict"),
}))

import { CostrictAuthStorage } from "./authStorage"
import { ensureCompletionRuntimeReady, writeCostrictRuntimeAuth } from "../runtime-config"

type MockProviderState = {
	currentApiConfigName: string
	apiConfiguration: {
		apiProvider: string
		costrictAccessToken: string
		costrictRefreshToken: string
		costrictState: string
	}
}

describe("CostrictAuthStorage.saveTokens", () => {
	let mockProvider: any

	const newTokens = {
		access_token: "new-access-token",
		refresh_token: "new-refresh-token",
		state: "new-state",
	}

	const buildState = (): MockProviderState => ({
		currentApiConfigName: "costrict-profile",
		apiConfiguration: {
			apiProvider: "costrict",
			costrictAccessToken: "old-access-token",
			costrictRefreshToken: "old-refresh-token",
			costrictState: "old-state",
		},
	})

	beforeEach(() => {
		vi.clearAllMocks()
		;(CostrictAuthStorage as any).instance = undefined

		mockProvider = {
			getState: vi.fn().mockResolvedValue(buildState()),
			providerSettingsManager: {
				saveMergeConfig: vi.fn().mockResolvedValue(undefined),
			},
			setValue: vi.fn(),
			upsertProviderProfile: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
		}

		CostrictAuthStorage.setProvider(mockProvider)
	})

	it("persists shared runtime auth after saving tokens", async () => {
		await CostrictAuthStorage.getInstance().saveTokens(newTokens as any)

		expect(writeCostrictRuntimeAuth).toHaveBeenCalledWith(newTokens.access_token, newTokens.refresh_token)
		expect(ensureCompletionRuntimeReady).toHaveBeenCalledTimes(1)
	})

	it("persists shared runtime auth regardless of legacy codebase toggle state", async () => {
		mockProvider.getState.mockResolvedValue(buildState())

		await CostrictAuthStorage.getInstance().saveTokens(newTokens as any)

		expect(writeCostrictRuntimeAuth).toHaveBeenCalledWith(newTokens.access_token, newTokens.refresh_token)
		expect(ensureCompletionRuntimeReady).toHaveBeenCalledTimes(1)
	})

	it("still persists when only the access_token changed (refresh unchanged)", async () => {
		// refresh_token is identical to the stored value. The dedup guard must
		// only no-op when BOTH tokens match, otherwise a rotated access_token
		// would be silently dropped.
		const rotatedAccess = {
			access_token: "new-access-token",
			refresh_token: "old-refresh-token",
			state: "new-state",
		}

		await CostrictAuthStorage.getInstance().saveTokens(rotatedAccess as any)

		expect(writeCostrictRuntimeAuth).toHaveBeenCalledWith(rotatedAccess.access_token, rotatedAccess.refresh_token)
		expect(ensureCompletionRuntimeReady).toHaveBeenCalledTimes(1)
	})

	it("recreates shared runtime auth when tokens already match the in-memory state", async () => {
		const sameTokens = {
			access_token: "old-access-token",
			refresh_token: "old-refresh-token",
			state: "old-state",
		}

		await CostrictAuthStorage.getInstance().saveTokens(sameTokens as any)

		expect(writeCostrictRuntimeAuth).toHaveBeenCalledWith(sameTokens.access_token, sameTokens.refresh_token)
		expect(ensureCompletionRuntimeReady).not.toHaveBeenCalled()
	})

	it("persists login state when tokens match but the OAuth state is missing", async () => {
		mockProvider.getState.mockResolvedValue({
			...buildState(),
			apiConfiguration: {
				...buildState().apiConfiguration,
				costrictState: "",
			},
		})
		const sameTokensWithState = {
			access_token: "old-access-token",
			refresh_token: "old-refresh-token",
			state: "restored-state",
		}

		await CostrictAuthStorage.getInstance().saveTokens(sameTokensWithState as any)

		expect(mockProvider.setValue).toHaveBeenCalledWith("costrictState", "restored-state")
		expect(mockProvider.upsertProviderProfile).toHaveBeenCalled()
	})

	it("never overwrites the active OpenAI Compatible profile while synchronizing login tokens", async () => {
		mockProvider.getState.mockResolvedValue({
			currentApiConfigName: "openai-compatible",
			apiConfiguration: {
				apiProvider: "openai",
				openAiBaseUrl: "https://example.test/v1",
				openAiModelId: "custom-model",
				costrictAccessToken: "",
				costrictRefreshToken: "",
				costrictState: "",
			},
		})

		await CostrictAuthStorage.getInstance().saveTokens(newTokens as any)

		expect(mockProvider.upsertProviderProfile).not.toHaveBeenCalled()
		const authPatch = mockProvider.providerSettingsManager.saveMergeConfig.mock.calls[0][0]
		expect(authPatch).not.toHaveProperty("apiProvider")
		expect(authPatch).not.toHaveProperty("openAiBaseUrl")
		expect(authPatch).not.toHaveProperty("openAiModelId")
	})
})
