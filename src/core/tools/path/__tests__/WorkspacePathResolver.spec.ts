import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { resolveWorkspacePath } from "../WorkspacePathResolver"

const temporaryDirectories: string[] = []

async function workspace(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "costrict-path-resolver-"))
	temporaryDirectories.push(directory)
	await fs.mkdir(path.join(directory, "src", "views"), { recursive: true })
	await fs.writeFile(path.join(directory, "src", "views", "SettingsView.tsx"), "export {}")
	return directory
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
	)
})

describe("resolveWorkspacePath", () => {
	it("returns exact existing paths", async () => {
		const cwd = await workspace()
		await expect(resolveWorkspacePath(cwd, "src/views/SettingsView.tsx")).resolves.toMatchObject({ exists: true })
	})

	it("finds a unique case correction", async () => {
		const cwd = await workspace()
		await expect(resolveWorkspacePath(cwd, "src/views/settingsview.tsx")).resolves.toMatchObject({
			exists: false,
			caseCorrection: "src/views/SettingsView.tsx",
		})
	})

	it("suggests verified paths for misspelled filenames", async () => {
		const cwd = await workspace()
		const result = await resolveWorkspacePath(cwd, "src/views/SettingView.tsx")
		expect(result.suggestions).toContain("src/views/SettingsView.tsx")
	})

	it("does not search outside the workspace", async () => {
		const cwd = await workspace()
		await expect(resolveWorkspacePath(cwd, "../secret.txt")).resolves.toMatchObject({
			exists: false,
			isOutsideWorkspace: true,
			suggestions: [],
		})
	})
})
