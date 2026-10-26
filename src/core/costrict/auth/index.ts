// Export storage module
export { CostrictAuthStorage } from "./authStorage"

// Export API module
export { CostrictAuthApi } from "./authApi"

// Export configuration module
export { CostrictAuthConfig } from "./authConfig"

// Export command handlers
export { CostrictAuthCommands } from "./authCommands"

// Export main authentication service
export { CostrictAuthService } from "./authService"

export {
	COSTRICT_AUTH_POLICY_VERSION,
	enforceCurrentAuthPolicy,
	hasAcceptedCurrentAuthPolicy,
	markCurrentAuthPolicyAccepted,
} from "./authPolicy"

// Export type definitions
export * from "./types"
