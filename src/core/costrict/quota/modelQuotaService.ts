import axios from "axios"
import { jwtDecode } from "jwt-decode"

import type { ExtensionMessage, ModelQuotaInfo, ProviderSettings } from "@roo-code/types"

import { CostrictAuthService } from "../auth"

const MODEL_QUOTA_ENDPOINT = process.env.DICODE_MODEL_QUOTA_URL || "http://10.111.175.240:3002/api/opentoken/key/quota"
const MODEL_QUOTA_TOKEN = "RBgAtwG5qJsnAmWg/IFA/vkSu8x+"
const MODEL_QUOTA_TIMEOUT_MS = 5_000

interface QuotaMessageTarget {
	postMessageToWebview(message: ExtensionMessage): Promise<void>
	log(message: string): void
}

interface QuotaQueryResponse {
	success?: boolean
	message?: unknown
	data?: {
		remain_quota_money?: number | string
		used_quota_money?: number | string
		unlimited_quota?: boolean
	}
}

const safeResponseMessage = (message: unknown, lookupKey: string): string => {
	if (typeof message !== "string" || message.trim() === "") return "none"
	return message
		.replaceAll(lookupKey, "[redacted]")
		.replace(/[\r\n]+/g, " ")
		.slice(0, 200)
}

const parseMoney = (value: number | string | undefined): number | undefined => {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined
	if (typeof value !== "string" || value.trim() === "") return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

const describeRequestFailure = (error: unknown): string => {
	if (!error || typeof error !== "object") return "unknown"
	const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } }
	const code = typeof candidate.code === "string" ? candidate.code : undefined
	const status =
		typeof candidate.response?.status === "number"
			? candidate.response.status
			: typeof candidate.status === "number"
				? candidate.status
				: undefined
	return [code, status ? `HTTP ${status}` : undefined].filter(Boolean).join(", ") || "unknown"
}

let activeRefresh: Promise<void> | undefined
let pendingRefresh: { target: QuotaMessageTarget; configuration: ProviderSettings } | undefined

const getQuotaLookupKey = (configuration: ProviderSettings): string | undefined => {
	if (configuration.apiProvider === "costrict") {
		const currentEmail = CostrictAuthService.getInstance()?.getUserInfo()?.email
		if (currentEmail?.trim()) return currentEmail.trim()

		try {
			const jwt = jwtDecode<any>(configuration.costrictAccessToken || "")
			const tokenEmail = jwt.email || jwt?.properties?.oauth_GitHub_email
			return typeof tokenEmail === "string" && tokenEmail.trim() ? tokenEmail.trim() : undefined
		} catch {
			return undefined
		}
	}

	if (configuration.apiProvider === "openai") {
		return configuration.openAiApiKey?.trim() || undefined
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

	const key = getQuotaLookupKey(configuration)
	if (!key) {
		target.log(
			configuration.apiProvider === "costrict"
				? "[ModelQuota] skipped: DiCode account email unavailable"
				: "[ModelQuota] skipped: OpenAI Compatible API key unavailable",
		)
		await target.postMessageToWebview({ type: "modelQuotaInfo" })
		return
	}

	{
		let response
		try {
			response = await axios.get<QuotaQueryResponse>(MODEL_QUOTA_ENDPOINT, {
				params: { key },
				headers: { "NEW-OPEN-TOKEN": MODEL_QUOTA_TOKEN },
				timeout: MODEL_QUOTA_TIMEOUT_MS,
			})
		} catch (error) {
			// Do not log the lookup key, request URL, headers, or API response because
			// the key may itself be an OpenAI-compatible credential.
			target.log(`[ModelQuota] request failed (${describeRequestFailure(error)})`)
			return
		}

		const remainQuotaMoney = parseMoney(response.data?.data?.remain_quota_money)
		const usedQuotaMoney = parseMoney(response.data?.data?.used_quota_money)
		if (response.data?.success === true && remainQuotaMoney !== undefined && usedQuotaMoney !== undefined) {
			const quota: ModelQuotaInfo = {
				remainQuotaMoney,
				usedQuotaMoney,
				unlimitedQuota: response.data.data?.unlimited_quota === true,
			}
			try {
				await target.postMessageToWebview({ type: "modelQuotaInfo", values: quota })
			} catch {
				target.log("[ModelQuota] failed to update the quota display")
			}
			return
		}

		const message = safeResponseMessage(response.data?.message, key)
		const topLevelKeys =
			response.data && typeof response.data === "object" ? Object.keys(response.data).sort().join(",") : "none"
		target.log(
			`[ModelQuota] invalid response (http=${response.status}, contentType=${response.headers?.["content-type"] || "unknown"}, keys=${topLevelKeys}, success=${String(response.data?.success)}, data=${Boolean(response.data?.data)}, remainType=${typeof response.data?.data?.remain_quota_money}, usedType=${typeof response.data?.data?.used_quota_money}, message=${message})`,
		)
		return
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
