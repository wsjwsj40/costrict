import type { ClineProvider } from "../../webview/ClineProvider"
import {
	clearCostrictRuntimeAuth,
	readCostrictAccessToken,
	readCostrictAuthPolicyVersion,
	writeCostrictAuthPolicyVersion,
} from "../runtime-config"
import { CostrictAuthStorage } from "./authStorage"

export const COSTRICT_AUTH_POLICY_VERSION = 1

export const getAcceptedAuthPolicyVersion = (): number => readCostrictAuthPolicyVersion()

export const hasAcceptedCurrentAuthPolicy = (): boolean =>
	getAcceptedAuthPolicyVersion() === COSTRICT_AUTH_POLICY_VERSION

export const markCurrentAuthPolicyAccepted = async (): Promise<void> =>
	writeCostrictAuthPolicyVersion(COSTRICT_AUTH_POLICY_VERSION)

/**
 * Invalidates authentication created before the current policy was introduced.
 * Provider API keys are deliberately left untouched; they become usable again
 * after the user completes the required DiCode login.
 */
export const enforceCurrentAuthPolicy = async (provider: ClineProvider): Promise<boolean> => {
	if (hasAcceptedCurrentAuthPolicy()) {
		return false
	}

	const storedTokens = await CostrictAuthStorage.getInstance().getTokens()
	let runtimeTokens: ReturnType<typeof readCostrictAccessToken> = null
	try {
		runtimeTokens = readCostrictAccessToken()
	} catch {
		// A malformed auth file is invalid authentication and is removed below.
	}

	const hadLegacyAuthentication = Boolean(
		storedTokens?.access_token || storedTokens?.refresh_token || storedTokens?.state || runtimeTokens,
	)
	if (hadLegacyAuthentication) {
		await CostrictAuthStorage.getInstance().clearAllLoginState()
		provider.log(`Authentication policy upgraded to v${COSTRICT_AUTH_POLICY_VERSION}; legacy session invalidated`)
	} else {
		// Also remove a malformed auth file, which readCostrictAccessToken cannot return.
		await clearCostrictRuntimeAuth()
	}

	return hadLegacyAuthentication
}
