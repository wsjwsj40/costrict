/**
 * Choose a valid Costrict model after the server model list is refreshed.
 *
 * The server response is the authoritative, permission-filtered list. Keep an
 * existing valid selection; otherwise use its first item, whose order is controlled
 * by the server.
 *
 * @returns the model id to switch to, or null when no correction should happen.
 */
export function getCorrectedCostrictModelId(newModelIds: string[], selectedModelId: string | undefined): string | null {
	if (newModelIds.length === 0) {
		return null
	}
	if (selectedModelId && newModelIds.includes(selectedModelId)) {
		return null
	}
	return newModelIds[0]
}
