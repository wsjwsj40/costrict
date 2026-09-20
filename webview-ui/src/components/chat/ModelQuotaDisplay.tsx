import { useEffect, useState } from "react"
import { WalletCards } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { ExtensionMessage, ModelQuotaInfo } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { StandardTooltip } from "@src/components/ui"

export const ModelQuotaDisplay = ({ compact = false, tableRow = false }: { compact?: boolean; tableRow?: boolean }) => {
	const { t } = useTranslation()
	const { apiConfiguration } = useExtensionState()
	const [quota, setQuota] = useState<ModelQuotaInfo>()
	const provider = apiConfiguration.apiProvider
	const supported = provider === "costrict" || provider === "openai"

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type !== "modelQuotaInfo") return
			const values = event.data.values as Partial<ModelQuotaInfo> | undefined
			if (values && typeof values.remainQuotaMoney === "number" && typeof values.usedQuotaMoney === "number") {
				setQuota({
					remainQuotaMoney: values.remainQuotaMoney,
					usedQuotaMoney: values.usedQuotaMoney,
					unlimitedQuota: values.unlimitedQuota === true,
				})
			} else {
				setQuota(undefined)
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	useEffect(() => {
		setQuota(undefined)
		if (supported) {
			vscode.postMessage({ type: "fetchModelQuota" })
		}
	}, [supported, provider, apiConfiguration.costrictAccessToken, apiConfiguration.openAiApiKey])

	if (!supported || !quota) return null

	const content = (
		<span className="inline-flex items-center gap-1 whitespace-nowrap">
			<WalletCards className="size-3" />
			<span>
				{quota.unlimitedQuota
					? t("chat:modelQuota.unlimited")
					: t("chat:modelQuota.remaining", { amount: quota.remainQuotaMoney.toFixed(2) })}
			</span>
			<span>·</span>
			<span>{t("chat:modelQuota.used", { amount: quota.usedQuotaMoney.toFixed(2) })}</span>
		</span>
	)

	if (tableRow) {
		return (
			<tr>
				<th className="font-medium text-left align-top w-1 whitespace-nowrap pr-3 h-[24px]">
					{t("chat:modelQuota.title")}
				</th>
				<td className="font-light align-top">{content}</td>
			</tr>
		)
	}

	if (!compact) return content

	return (
		<StandardTooltip content={t("chat:modelQuota.tooltip")} side="top" sideOffset={8}>
			{content}
		</StandardTooltip>
	)
}
