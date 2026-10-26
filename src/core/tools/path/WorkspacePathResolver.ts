import fs from "fs/promises"
import path from "path"

export interface WorkspacePathResolution {
	requestedPath: string
	normalizedPath: string
	absolutePath: string
	exists: boolean
	isOutsideWorkspace: boolean
	caseCorrection?: string
	suggestions: string[]
}

function distance(left: string, right: string): number {
	const row = Array.from({ length: left.length + 1 }, (_, index) => index)
	for (let i = 1; i <= right.length; i++) {
		let previous = row[0]
		row[0] = i
		for (let j = 1; j <= left.length; j++) {
			const current = row[j]
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[j - 1] === right[i - 1] ? 0 : 1))
			previous = current
		}
	}
	return row[left.length]
}

async function collectFiles(root: string, limit = 10_000): Promise<string[]> {
	const result: string[] = []
	const pending = [root]
	while (pending.length && result.length < limit) {
		const directory = pending.pop()!
		let entries: import("fs").Dirent[]
		try {
			entries = await fs.readdir(directory, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if ([".git", "node_modules", "dist", "out", ".turbo"].includes(entry.name)) continue
			const absolute = path.join(directory, entry.name)
			if (entry.isDirectory()) pending.push(absolute)
			else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join("/"))
			if (result.length >= limit) break
		}
	}
	return result
}

export async function resolveWorkspacePath(
	cwd: string,
	requestedPath: string,
	isAllowed: (relativePath: string) => boolean = () => true,
): Promise<WorkspacePathResolution> {
	const normalizedPath = path
		.normalize(requestedPath)
		.replace(/^([.][\/])+/, "")
		.split(path.sep)
		.join("/")
	const absolutePath = path.resolve(cwd, normalizedPath)
	const relative = path.relative(cwd, absolutePath)
	const isOutsideWorkspace = relative.startsWith("..") || path.isAbsolute(relative)
	if (isOutsideWorkspace) {
		return { requestedPath, normalizedPath, absolutePath, exists: false, isOutsideWorkspace, suggestions: [] }
	}

	try {
		await fs.access(absolutePath)
		return { requestedPath, normalizedPath, absolutePath, exists: true, isOutsideWorkspace: false, suggestions: [] }
	} catch {
		// Resolve against verified workspace entries below.
	}

	const files = (await collectFiles(cwd)).filter(isAllowed)
	const lower = normalizedPath.toLowerCase()
	const caseCorrection = files.find((candidate) => candidate.toLowerCase() === lower)
	const requestedBase = path.posix.basename(normalizedPath).toLowerCase()
	const requestedDir = path.posix.dirname(normalizedPath).toLowerCase()
	const suggestions = files
		.map((candidate) => {
			const base = path.posix.basename(candidate).toLowerCase()
			const dir = path.posix.dirname(candidate).toLowerCase()
			const baseDistance = distance(requestedBase, base)
			const sameBase = base === requestedBase
			const score = (sameBase ? 100 : Math.max(0, 70 - baseDistance * 15)) + (dir === requestedDir ? 25 : 0)
			return { candidate, score, baseDistance, sameBase }
		})
		.filter(
			({ baseDistance, sameBase }) =>
				sameBase || baseDistance <= Math.max(2, Math.floor(requestedBase.length / 4)),
		)
		.sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
		.slice(0, 3)
		.map(({ candidate }) => candidate)

	return {
		requestedPath,
		normalizedPath,
		absolutePath,
		exists: false,
		isOutsideWorkspace: false,
		caseCorrection,
		suggestions,
	}
}

export function formatPathRecoveryError(tool: string, field: string, resolution: WorkspacePathResolution): string {
	const details = JSON.stringify({
		error: resolution.isOutsideWorkspace ? "PATH_OUTSIDE_WORKSPACE" : "PATH_NOT_FOUND",
		tool,
		field,
		requested: resolution.requestedPath,
		suggestions: resolution.suggestions,
		instruction: resolution.suggestions.length
			? "Retry using one of the verified paths. If the target is ambiguous, ask the user to choose."
			: "Use list_files or search_files to locate the target, then retry with an exact path.",
		retryable: !resolution.isOutsideWorkspace,
	})
	return `File does not exist at path: ${resolution.requestedPath}\n\n<error_details>\n${details}\n</error_details>`
}
