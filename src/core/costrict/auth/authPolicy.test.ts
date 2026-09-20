import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getTokens: vi.fn(),
	clearAllLoginState: vi.fn(),
	readCostrictAccessToken: vi.fn(),
	clearCostrictRuntimeAuth: vi.fn(),
	readCostrictAuthPolicyVersion: vi.fn(),
	writeCostrictAuthPolicyVersion: vi.fn(),
}))

vi.mock("./authStorage", () => ({
	CostrictAuthStorage: {
		getInstance: () => ({
			getTokens: mocks.getTokens,
			clearAllLoginState: mocks.clearAllLoginState,
		}),
	},
}))

vi.mock("../runtime-config", () => ({
	readCostrictAccessToken: mocks.readCostrictAccessToken,
	clearCostrictRuntimeAuth: mocks.clearCostrictRuntimeAuth,
	readCostrictAuthPolicyVersion: mocks.readCostrictAuthPolicyVersion,
	writeCostrictAuthPolicyVersion: mocks.writeCostrictAuthPolicyVersion,
}))

import { COSTRICT_AUTH_POLICY_VERSION, enforceCurrentAuthPolicy, markCurrentAuthPolicyAccepted } from "./authPolicy"

describe("authentication policy migration", () => {
	let provider: any

	beforeEach(() => {
		vi.clearAllMocks()
		provider = {
			log: vi.fn(),
		}
		mocks.clearAllLoginState.mockResolvedValue(undefined)
		mocks.clearCostrictRuntimeAuth.mockResolvedValue(undefined)
		mocks.readCostrictAuthPolicyVersion.mockReturnValue(0)
		mocks.writeCostrictAuthPolicyVersion.mockResolvedValue(undefined)
	})

	it("invalidates a pre-policy session without touching provider API-key settings", async () => {
		mocks.getTokens.mockResolvedValue({ access_token: "old", refresh_token: "old-refresh", state: "s" })
		mocks.readCostrictAccessToken.mockReturnValue({ access_token: "old", refresh_token: "old-refresh" })

		expect(await enforceCurrentAuthPolicy(provider)).toBe(true)
		expect(mocks.clearAllLoginState).toHaveBeenCalledOnce()
		expect(mocks.clearCostrictRuntimeAuth).not.toHaveBeenCalled()
	})

	it("does not invalidate a session already accepted under the current policy", async () => {
		mocks.readCostrictAuthPolicyVersion.mockReturnValue(COSTRICT_AUTH_POLICY_VERSION)

		expect(await enforceCurrentAuthPolicy(provider)).toBe(false)
		expect(mocks.getTokens).not.toHaveBeenCalled()
		expect(mocks.clearAllLoginState).not.toHaveBeenCalled()
	})

	it("records the policy version only after successful login", async () => {
		await markCurrentAuthPolicyAccepted()

		expect(mocks.writeCostrictAuthPolicyVersion).toHaveBeenCalledWith(COSTRICT_AUTH_POLICY_VERSION)
	})

	it("accepts a policy version written by another extension window", async () => {
		mocks.readCostrictAuthPolicyVersion.mockReturnValue(COSTRICT_AUTH_POLICY_VERSION)

		expect(await enforceCurrentAuthPolicy(provider)).toBe(false)
		expect(mocks.clearAllLoginState).not.toHaveBeenCalled()
	})
})
