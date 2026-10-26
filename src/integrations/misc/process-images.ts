import * as vscode from "vscode"
import { readImageAsDataUrlWithBuffer } from "../../core/tools/helpers/imageHelpers"

export async function selectImages(): Promise<string[]> {
	const options: vscode.OpenDialogOptions = {
		canSelectMany: true,
		openLabel: "Select",
		filters: {
			Images: ["png", "jpg", "jpeg", "webp", "svg"],
		},
	}

	const fileUris = await vscode.window.showOpenDialog(options)

	if (!fileUris || fileUris.length === 0) {
		return []
	}

	return await Promise.all(
		fileUris.map(async (uri) => {
			const imagePath = uri.fsPath
			const { dataUrl } = await readImageAsDataUrlWithBuffer(imagePath)
			return dataUrl
		}),
	)
}
