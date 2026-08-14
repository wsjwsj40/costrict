import axios from "axios"
import { jwtDecode } from "jwt-decode"

import type { ExtensionMessage, ModelQuotaInfo, ProviderSettings } from "@roo-code/types"

import { CostrictAuthService } from "../auth"

const MODEL_QUOTA_ENDPOINT = "http://10.111.175.240:3002/api/opentoken/key/quota"
const MODEL_QUOTA_TOKEN = "RBgAtwG5qJsnAmWg/IFA/vkSu8x+"
const MODEL_QUOTA_TIMEOUT_MS = 5_000

interface QuotaMessageTarget {
	postMessageToWebview(message: ExtensionMessage): Promise<void>
	log(message: string): void
}

interface QuotaQueryResponse {
	success?: boolean
	data?: {
		remain_quota_money?: number
		used_quota_money?: number
		unlimited_quota?: boolean
	}
}

let activeRefresh: Promise<void> | undefined
let pendingRefresh: { target: QuotaMessageTarget; configuration: ProviderSettings } | undefined

const getQuotaLookupKey = (configuration: ProviderSettings): string | undefined => {
	if (configuration.apiProvider === "costrict") {
		const currentEmail = CostrictAuthService.getInstance()?.getUserInfo()?.email
		if (currentEmail) return currentEmail

		try {
			const jwt = jwtDecode<any>(configuration.costrictAccessToken || "")
			return jwt.email || jwt?.properties?.oauth_GitHub_email
		} catch {
			return undefined
		}
	}

	if (configuration.apiProvider === "openai") {
		return configuration.openAiApiKey
	}

	return undefined
}

const fetchAndPublishModelQuota = async (
	target: QuotaMessageTarget,
	configuration: ProviderSettings,
): Promise<void> => {
	if (configuration.apiProvider !== "costrict" && configuration.apiProvider !== "openai") {
		return
	}

	const key = getQuotaLookupKey(configuration)?.trim()
	if (!key) {
		target.log(
			configuration.apiProvider === "costrict"
				? "[ModelQuota] skipped: DiCode account email unavailable"
				: "[ModelQuota] skipped: OpenAI Compatible API key unavailable",
		)
		await target.postMessageToWebview({ type: "modelQuotaInfo" })
		return
	}

	try {
		const response = await axios.get<QuotaQueryResponse>(MODEL_QUOTA_ENDPOINT, {
			params: { key },
			headers: { "NEW-OPEN-TOKEN": MODEL_QUOTA_TOKEN },
			timeout: MODEL_QUOTA_TIMEOUT_MS,
		})
		const remainQuotaMoney = response.data?.data?.remain_quota_money
		const usedQuotaMoney = response.data?.data?.used_quota_money
		if (
			response.data?.success !== true ||
			typeof remainQuotaMoney !== "number" ||
			typeof usedQuotaMoney !== "number"
		) {
			throw new Error("invalid quota response")
		}

		const quota: ModelQuotaInfo = {
			remainQuotaMoney,
			usedQuotaMoney,
			unlimitedQuota: response.data.data?.unlimited_quota === true,
		}
		await target.postMessageToWebview({ type: "modelQuotaInfo", values: quota })
	} catch (error) {
		// Do not log the lookup key, request URL, headers, or API response because
		// the key may itself be an OpenAI-compatible credential.
		const reason = axios.isAxiosError(error) ? (error.code ?? error.response?.status ?? "request error") : "error"
		target.log(`[ModelQuota] refresh failed (${reason})`)
	}
}

/**
 * Refresh quota without allowing overlapping requests. If another refresh is
 * requested while one is running, only the most recent configuration is run next.
 */
export const refreshModelQuota = async (target: QuotaMessageTarget, configuration: ProviderSettings): Promise<void> => {
	if (activeRefresh) {
		pendingRefresh = { target, configuration }
		return activeRefresh
	}

	activeRefresh = fetchAndPublishModelQuota(target, configuration)
	try {
		await activeRefresh
	} finally {
		activeRefresh = undefined
		const pending = pendingRefresh
		pendingRefresh = undefined
		if (pending) {
			await refreshModelQuota(pending.target, pending.configuration)
		}
	}
}
