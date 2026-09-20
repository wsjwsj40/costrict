import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Trans } from "react-i18next"

import { Info, Download, Upload, TriangleAlert, Bug, MessageCircle, MessagesSquare } from "lucide-react"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import type { TelemetrySetting } from "@roo-code/types"

import { Package } from "@roo/package"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type AboutProps = HTMLAttributes<HTMLDivElement> & {
	telemetrySetting: TelemetrySetting
	setTelemetrySetting: (setting: TelemetrySetting) => void
	debug?: boolean
	setDebug?: (debug: boolean) => void
}

function formatBuildTime(isoString: string | undefined): string | undefined {
	if (!isoString) return undefined
	const date = new Date(isoString)
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	const hours = String(date.getHours()).padStart(2, "0")
	const minutes = String(date.getMinutes()).padStart(2, "0")
	const seconds = String(date.getSeconds()).padStart(2, "0")
	return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
}

export const About = ({ telemetrySetting, setTelemetrySetting, debug, setDebug, className, ...props }: AboutProps) => {
	const { t } = useAppTranslation()

	const buildTime = formatBuildTime(Package.buildTime)
	const versionDescription = Package.sha
		? `Version: ${Package.version} (${Package.sha.slice(0, 8)})`
		: `Version: ${Package.version}`
	const description = buildTime ? `${versionDescription} · Build: ${buildTime}` : versionDescription

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader description={description}>
				<div className="flex items-center gap-2">
					<Info className="w-4" />
					<div>{t("settings:sections.about")}</div>
				</div>
			</SectionHeader>

			<Section>
				<div style={{ display: "none" }}>
					<VSCodeCheckbox
						checked={telemetrySetting === "enabled"}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							setTelemetrySetting(checked ? "enabled" : "disabled")
						}}>
						{t("settings:footer.telemetry.label")}
					</VSCodeCheckbox>
					<p className="text-vscode-descriptionForeground text-sm mt-0">
						<Trans
							i18nKey="settings:footer.telemetry.description"
							components={{
								privacyLink: <VSCodeLink href="https://roocode.com/privacy" />,
							}}
						/>
					</p>
				</div>
			</Section>

			<Section className="space-y-0">
				<h3>{t("settings:about.contactAndCommunity")}</h3>
				<div className="flex flex-col gap-3">
					<div className="flex items-start gap-2">
						<Bug className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							问题反馈 <VSCodeLink href="https://gcyai.byd.com/modify/message_board">留言板</VSCodeLink>
						</span>
					</div>
					<div className="flex items-start gap-2">
						<Download className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							版本检查 运行{" "}
							<VSCodeLink
								href="#"
								onClick={(event) => {
									event.preventDefault()
									vscode.postMessage({ type: "checkForUpdates" })
								}}>
								Dicode: Check for Updates
							</VSCodeLink>{" "}
							检查版本
						</span>
					</div>
					<div className="flex items-start gap-2">
						<Info className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							了解更多信息{" "}
							<VSCodeLink href="https://aiservice.byd.com/dicode/">DiCode 官方网站</VSCodeLink>
						</span>
					</div>
					<div className="flex items-start gap-2">
						<MessageCircle className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							联系我们 曾心怡 <VSCodeLink href="mailto:zeng.xinyi@byd.com">zeng.xinyi@byd.com</VSCodeLink>
						</span>
					</div>
					<div className="flex items-start gap-2">
						<MessagesSquare className="size-4 text-vscode-descriptionForeground shrink-0" />
						<span>
							获取使用技巧或与其他 DiCode 用户交流{" "}
							<VSCodeLink href="https://aiservice.byd.com/dicode/communication">
								查看 DiCode 用户交流群最新二维码
							</VSCodeLink>
						</span>
					</div>
					{setDebug && (
						<SearchableSetting
							settingId="about-debug-mode"
							section="about"
							label={t("settings:about.debugMode.label")}
							className="mt-4 pt-4 border-t border-vscode-settings-headerBorder">
							<VSCodeCheckbox
								checked={debug ?? false}
								onChange={(e: any) => {
									const checked = e.target.checked === true
									setDebug(checked)
								}}>
								{t("settings:about.debugMode.label")}
							</VSCodeCheckbox>
							<p className="text-vscode-descriptionForeground text-sm mt-0">
								{t("settings:about.debugMode.description")}
							</p>
						</SearchableSetting>
					)}
				</div>
			</Section>

			<Section className="space-y-0">
				<SearchableSetting
					settingId="about-manage-settings"
					section="about"
					label={t("settings:about.manageSettings")}>
					<h3>{t("settings:about.manageSettings")}</h3>
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => vscode.postMessage({ type: "exportSettings" })} className="w-28">
							<Upload className="p-0.5" />
							{t("settings:footer.settings.export")}
						</Button>
						<Button onClick={() => vscode.postMessage({ type: "importSettings" })} className="w-28">
							<Download className="p-0.5" />
							{t("settings:footer.settings.import")}
						</Button>
						<Button
							variant="destructive"
							onClick={() => vscode.postMessage({ type: "resetState" })}
							className="w-28">
							<TriangleAlert className="p-0.5" />
							{t("settings:footer.settings.reset")}
						</Button>

						<Button
							variant="destructive"
							onClick={() => vscode.postMessage({ type: "fixHistory" })}
							className="w-28">
							<TriangleAlert className="p-0.5" />
							<span className="text-xs">{t("settings:footer.settings.fixHistory")}</span>
						</Button>
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
