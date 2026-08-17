import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ProviderSettings } from "@roo-code/types"

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	getUserInfo: vi.fn(),
}))

vi.mock("axios", () => ({ default: { get: mocks.get, isAxiosError: () => false } }))
vi.mock("../../auth", () => ({
	CostrictAuthService: {
		getInstance: () => ({ getUserInfo: mocks.getUserInfo }),
	},
}))

import { refreshModelQuota } from "../modelQuotaService"

describe("refreshModelQuota", () => {
	const target = {
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.get.mockResolvedValue({
			data: {
				success: true,
				data: { remain_quota_money: 20, used_quota_money: 0.5, unlimited_quota: false },
			},
		})
	})

	it("queries DiCode quota by the signed-in email", async () => {
		mocks.getUserInfo.mockReturnValue({ email: "user@byd.com" })

		await refreshModelQuota(target, { apiProvider: "costrict" } as ProviderSettings)

		expect(mocks.get).toHaveBeenCalledWith(
			"http://10.111.175.240:3002/api/opentoken/key/quota",
			expect.objectContaining({ params: { key: "user@byd.com" } }),
		)
		expect(target.postMessageToWebview).toHaveBeenCalledWith({
			type: "modelQuotaInfo",
			values: { remainQuotaMoney: 20, usedQuotaMoney: 0.5, unlimitedQuota: false },
		})
	})

	it("falls back to the configured DiCode JWT email after extension restart", async () => {
		mocks.getUserInfo.mockReturnValue(undefined)
		const payload = Buffer.from(JSON.stringify({ properties: { oauth_GitHub_email: "jwt@byd.com" } }))
			.toString("base64url")
			.replace(/=/g, "")

		await refreshModelQuota(target, {
			apiProvider: "costrict",
			costrictAccessToken: `e30.${payload}.signature`,
		} as ProviderSettings)

		expect(mocks.get).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ params: { key: "jwt@byd.com" } }),
		)
	})

	it("preserves the unlimited quota flag", async () => {
		mocks.getUserInfo.mockReturnValue({ email: "user@byd.com" })
		mocks.get.mockResolvedValue({
			data: {
				success: true,
				data: { remain_quota_money: 0, used_quota_money: 0.5, unlimited_quota: true },
			},
		})

		await refreshModelQuota(target, { apiProvider: "costrict" } as ProviderSettings)

		expect(target.postMessageToWebview).toHaveBeenCalledWith({
			type: "modelQuotaInfo",
			values: { remainQuotaMoney: 0, usedQuotaMoney: 0.5, unlimitedQuota: true },
		})
	})

	it("accepts money amounts returned as numeric strings", async () => {
		mocks.getUserInfo.mockReturnValue({ email: "user@byd.com" })
		mocks.get.mockResolvedValue({
			data: {
				success: true,
				data: { remain_quota_money: "20", used_quota_money: "0.5", unlimited_quota: false },
			},
		})

		await refreshModelQuota(target, { apiProvider: "costrict" } as ProviderSettings)

		expect(target.postMessageToWebview).toHaveBeenCalledWith({
			type: "modelQuotaInfo",
			values: { remainQuotaMoney: 20, usedQuotaMoney: 0.5, unlimitedQuota: false },
		})
	})

	it("logs safe response metadata for business errors", async () => {
		mocks.getUserInfo.mockReturnValue({ email: "user@byd.com" })
		mocks.get.mockResolvedValue({
			status: 200,
			headers: { "content-type": "application/json" },
			data: { success: false, message: "key user@byd.com does not exist" },
		})

		await refreshModelQuota(target, { apiProvider: "costrict" } as ProviderSettings)

		expect(target.log).toHaveBeenCalledWith(expect.stringContaining("http=200"))
		expect(target.log).toHaveBeenCalledWith(expect.stringContaining("key [redacted] does not exist"))
		expect(target.log).not.toHaveBeenCalledWith(expect.stringContaining("user@byd.com"))
	})

	it("queries OpenAI Compatible quota by API key", async () => {
		await refreshModelQuota(target, {
			apiProvider: "openai",
			openAiApiKey: "openai-compatible-key",
		} as ProviderSettings)

		expect(mocks.get).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ params: { key: "openai-compatible-key" } }),
		)
	})

	it("ignores unsupported providers without calling the endpoint", async () => {
		await refreshModelQuota(target, { apiProvider: "anthropic" } as ProviderSettings)

		expect(mocks.get).not.toHaveBeenCalled()
		expect(target.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("keeps the last displayed value when refresh fails", async () => {
		mocks.getUserInfo.mockReturnValue({ email: "user@byd.com" })
		mocks.get.mockRejectedValue(new Error("network error containing sensitive request details"))

		await refreshModelQuota(target, { apiProvider: "costrict" } as ProviderSettings)

		expect(target.postMessageToWebview).not.toHaveBeenCalled()
		expect(target.log).toHaveBeenCalledWith("[ModelQuota] request failed (unknown)")
	})
})
