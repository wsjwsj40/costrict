const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function normalizeVersion(version: string): string {
	const normalized = version.trim().replace(/^v/i, "")
	if (!VERSION_PATTERN.test(normalized)) {
		throw new Error(`Invalid semantic version: ${version}`)
	}
	return normalized
}

export function isNewerVersion(candidate: string, current: string): boolean {
	return compareVersions(candidate, current) > 0
}

export function isBelowMinimum(current: string, minimum?: string): boolean {
	return minimum ? compareVersions(current, minimum) < 0 : false
}

function compareVersions(left: string, right: string): number {
	const leftMatch = VERSION_PATTERN.exec(normalizeVersion(left))!
	const rightMatch = VERSION_PATTERN.exec(normalizeVersion(right))!

	for (let index = 1; index <= 3; index++) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index])
		if (difference !== 0) {
			return Math.sign(difference)
		}
	}

	const leftPrerelease = leftMatch[4]
	const rightPrerelease = rightMatch[4]
	if (!leftPrerelease && !rightPrerelease) return 0
	if (!leftPrerelease) return 1
	if (!rightPrerelease) return -1

	const leftIdentifiers = leftPrerelease.split(".")
	const rightIdentifiers = rightPrerelease.split(".")
	for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index++) {
		const leftIdentifier = leftIdentifiers[index]
		const rightIdentifier = rightIdentifiers[index]
		if (leftIdentifier === undefined) return -1
		if (rightIdentifier === undefined) return 1
		if (leftIdentifier === rightIdentifier) continue

		const leftNumeric = /^\d+$/.test(leftIdentifier)
		const rightNumeric = /^\d+$/.test(rightIdentifier)
		if (leftNumeric && rightNumeric) {
			return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1
		}
		if (leftNumeric !== rightNumeric) {
			return leftNumeric ? -1 : 1
		}
		return leftIdentifier < rightIdentifier ? -1 : 1
	}
	return 0
}
