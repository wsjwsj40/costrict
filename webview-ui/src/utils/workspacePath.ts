export function normalizeWorkspacePathForComparison(value?: string): string {
	if (!value) return ""
	let normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
	if (/^[a-zA-Z]:\//.test(normalized)) normalized = normalized.toLowerCase()
	return normalized
}

export function workspacePathsEqual(left?: string, right?: string): boolean {
	const normalizedLeft = normalizeWorkspacePathForComparison(left)
	const normalizedRight = normalizeWorkspacePathForComparison(right)
	return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}
