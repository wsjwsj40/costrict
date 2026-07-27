import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { pipeline } from "stream/promises"
import { Transform } from "stream"
import axios from "axios"
import * as vscode from "vscode"

import { parseUpdateManifest, validateUpdateUrls } from "./manifest"
import type { UpdateCheckResult, UpdateManifest } from "./types"
import { isBelowMinimum, isNewerVersion } from "./version"

const LAST_CHECK_KEY = "dicodeUpdater.lastSuccessfulCheck"
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_PACKAGE_BYTES = 500 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const INSTALL_NOW = "立即更新"
const REMIND_LATER = "稍后提醒"
const MANUAL_DOWNLOAD = "手动下载"
const RELOAD = "重新加载"
const MANIFEST_URL = process.env.DICODE_UPDATE_MANIFEST_URL?.trim() ?? ""
const ALLOW_INSECURE_HTTP = process.env.DICODE_UPDATE_ALLOW_INSECURE_HTTP === "true"

export class ExtensionUpdater implements vscode.Disposable {
	private timer: NodeJS.Timeout | undefined
	private checkInProgress: Promise<void> | undefined

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
	) {}

	start(): void {
		if (!MANIFEST_URL) {
			this.log("This build does not include an update manifest URL.")
			return
		}

		void this.checkForUpdates(false)
		this.timer = setInterval(() => void this.checkForUpdates(false), CHECK_INTERVAL_MS)
		this.timer.unref?.()
	}

	async checkForUpdates(manual: boolean): Promise<void> {
		if (this.checkInProgress) {
			if (manual) {
				void vscode.window.showInformationMessage("DiCode 正在检查更新。")
			}
			return this.checkInProgress
		}

		this.checkInProgress = this.performCheck(manual).finally(() => {
			this.checkInProgress = undefined
		})
		return this.checkInProgress
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	private async performCheck(manual: boolean): Promise<void> {
		if (!MANIFEST_URL) {
			if (manual) {
				void vscode.window.showInformationMessage("当前 DiCode 安装包未配置内网更新服务。")
			}
			return
		}

		const lastCheck = this.context.globalState.get<number>(LAST_CHECK_KEY, 0)
		if (!manual && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
			return
		}

		try {
			const result = await this.fetchUpdate()
			await this.context.globalState.update(LAST_CHECK_KEY, Date.now())
			if (!result) {
				if (manual) {
					void vscode.window.showInformationMessage("DiCode 已是最新版本。")
				}
				return
			}
			await this.promptForUpdate(result)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log(`Update check failed: ${message}`)
			const action = await vscode.window.showErrorMessage(
				manual ? `检查 DiCode 更新失败：${message}` : "DiCode 自动检查更新失败，可以尝试手动下载。",
				MANUAL_DOWNLOAD,
			)
			if (action === MANUAL_DOWNLOAD) {
				await this.openDownload()
			}
		}
	}

	private async fetchUpdate(): Promise<UpdateCheckResult | undefined> {
		validateUpdateUrls(MANIFEST_URL, MANIFEST_URL, ALLOW_INSECURE_HTTP)

		const response = await axios.get<unknown>(MANIFEST_URL, {
			timeout: REQUEST_TIMEOUT_MS,
			responseType: "json",
			headers: { Accept: "application/json" },
		})
		const manifest = parseUpdateManifest(response.data)

		const currentVersion = String(this.context.extension.packageJSON.version)
		if (!isNewerVersion(manifest.version, currentVersion)) {
			return undefined
		}

		return {
			manifest,
			mandatory: Boolean(manifest.mandatory) || isBelowMinimum(currentVersion, manifest.minimumVersion),
		}
	}

	private async promptForUpdate(result: UpdateCheckResult): Promise<void> {
		const currentVersion = String(this.context.extension.packageJSON.version)
		const detail = [
			`当前版本：${currentVersion}`,
			`最新版本：${result.manifest.version}`,
			result.manifest.releaseNotes ? `\n${result.manifest.releaseNotes}` : "",
		]
			.filter(Boolean)
			.join("\n")

		const actions = result.mandatory ? [INSTALL_NOW, MANUAL_DOWNLOAD] : [INSTALL_NOW, REMIND_LATER, MANUAL_DOWNLOAD]
		const selection = await vscode.window.showInformationMessage(
			result.mandatory ? "DiCode 管理员已将此版本标记为必须更新。" : "发现 DiCode 新版本。",
			{ modal: result.mandatory, detail },
			...actions,
		)

		if (selection === INSTALL_NOW) {
			await this.downloadAndInstall(result.manifest)
		} else if (selection === MANUAL_DOWNLOAD) {
			await this.openDownload()
		}
	}

	private async downloadAndInstall(manifest: UpdateManifest): Promise<void> {
		const downloadUrl = this.getDownloadUrl()
		const targetPath = path.join(this.context.globalStorageUri.fsPath, `dicode-${manifest.version}.vsix`)
		try {
			await vscode.workspace.fs.createDirectory(this.context.globalStorageUri)

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `正在下载 DiCode ${manifest.version}`,
					cancellable: false,
				},
				async (progress) => {
					await this.downloadFile(downloadUrl, targetPath, manifest.sha256, (percent) =>
						progress.report({ increment: percent }),
					)
				},
			)

			this.log(`Installing update from ${targetPath}`)
			await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(targetPath))

			const action = await vscode.window.showInformationMessage(
				`DiCode ${manifest.version} 已安装，重新加载窗口后生效。`,
				RELOAD,
			)
			if (action === RELOAD) {
				await vscode.commands.executeCommand("workbench.action.reloadWindow")
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.log(`Automatic update failed: ${message}`)
			const action = await vscode.window.showErrorMessage(`自动安装 DiCode 更新失败：${message}`, MANUAL_DOWNLOAD)
			if (action === MANUAL_DOWNLOAD) {
				await this.openDownload()
			}
		} finally {
			await fs.promises.rm(targetPath, { force: true }).catch((error) => {
				this.log(`Failed to remove temporary update package: ${String(error)}`)
			})
		}
	}

	private async downloadFile(
		url: string,
		targetPath: string,
		expectedSha256: string,
		onProgress: (increment: number) => void,
	): Promise<void> {
		const response = await axios.get<NodeJS.ReadableStream>(url, {
			timeout: 60_000,
			responseType: "stream",
			maxContentLength: MAX_PACKAGE_BYTES,
			maxBodyLength: MAX_PACKAGE_BYTES,
		})
		const contentLength = Number(response.headers["content-length"] ?? 0)
		if (contentLength > MAX_PACKAGE_BYTES) {
			throw new Error("更新包超过 500 MB 限制")
		}

		let downloaded = 0
		let reported = 0
		const hash = crypto.createHash("sha256")
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				downloaded += chunk.length
				if (downloaded > MAX_PACKAGE_BYTES) {
					callback(new Error("更新包超过 500 MB 限制"))
					return
				}
				hash.update(chunk)
				if (contentLength > 0) {
					const percent = (downloaded / contentLength) * 100
					onProgress(Math.max(0, percent - reported))
					reported = percent
				}
				callback(null, chunk)
			},
		})

		try {
			await pipeline(response.data, counter, fs.createWriteStream(targetPath, { mode: 0o600 }))
			const actualSha256 = hash.digest("hex")
			if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
				throw new Error("更新包 SHA-256 校验失败")
			}
		} catch (error) {
			await fs.promises.rm(targetPath, { force: true })
			throw error
		}
	}

	private async openDownload(): Promise<void> {
		await vscode.env.openExternal(vscode.Uri.parse(this.getDownloadUrl()))
	}

	private getDownloadUrl(): string {
		const url = new URL(MANIFEST_URL)
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/download`
		url.search = ""
		url.hash = ""
		return url.toString()
	}

	private log(message: string): void {
		this.outputChannel.appendLine(`[Updater] ${message}`)
	}
}
