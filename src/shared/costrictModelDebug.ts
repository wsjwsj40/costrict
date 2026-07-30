/**
 * Build-time gate for Costrict model overrides.
 *
 * This is deliberately opt-in. Set COSTRICT_ENABLE_MODEL_DEBUG=true while
 * building both the extension host and webview to produce an internal debug
 * build that exposes and honors custom Costrict model settings.
 */
export const costrictModelDebugBuildEnabled = process.env.COSTRICT_ENABLE_MODEL_DEBUG === "true"
