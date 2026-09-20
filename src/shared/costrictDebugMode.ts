/**
 * Build-time gate for exposing the general Debug mode entry.
 *
 * This is deliberately opt-in. Set COSTRICT_ENABLE_DEBUG_MODE=true while
 * building both the extension host and webview to produce an internal build
 * where a user may explicitly enable Debug mode.
 */
export const costrictDebugModeBuildEnabled = process.env.COSTRICT_ENABLE_DEBUG_MODE === "true"

export const COSTRICT_CUSTOM_CONFIG_CONSENT_VERSION = 1
