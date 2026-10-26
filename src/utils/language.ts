/**
 * Language cache variable to store the obtained language result.
 * Type is Promise<string> | null, initially null indicates not fetched yet.
 */
let languageCache: Promise<string> | null = null

/**
 * Reset the language cache. Used primarily for testing.
 */
export const resetLanguageCache = (): void => {
	languageCache = null
}

/**
 * Get the default language for a fresh installation.
 * Users can still change and persist their language from Settings.
 * @returns Promise with the determined language string
 */
async function getDefaultLanguage(): Promise<string> {
	return process.env.DICODE_DEFAULT_LANGUAGE || "zh-CN"
}

/**
 * Cached function to get the default language.
 * If the language is not yet fetched, calls getDefaultLanguage() and caches the result.
 * Subsequent calls directly return the cached result.
 * @returns Promise with the determined language string
 */
export const defaultLang = (): Promise<string> => {
	if (!languageCache) {
		console.log("[language] Fetching default language...")
		languageCache = getDefaultLanguage()
	}

	return languageCache
}
