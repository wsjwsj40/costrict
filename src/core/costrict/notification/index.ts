import { ClineProvider } from "../../webview/ClineProvider"
import { NotificationService } from "./notificationService"

export async function initNotificationService(provider: ClineProvider) {
	try {
		const notificationService = NotificationService.getInstance()
		await notificationService.initialize(provider)
	} catch (err) {
		provider.log(`[DiCode#initNotificationService] Failed to initialize notification service: ${err}`)
	}
}

export { NotificationService }
