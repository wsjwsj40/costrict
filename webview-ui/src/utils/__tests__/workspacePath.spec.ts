import { describe, expect, it } from "vitest"

import { workspacePathsEqual } from "../workspacePath"

describe("workspacePathsEqual", () => {
	it("normalizes Windows separators, drive casing and trailing separators", () => {
		expect(workspacePathsEqual("D:\\Projects\\DiCode", "d:/projects/dicode/")).toBe(true)
	})

	it("keeps case-sensitive POSIX paths distinct", () => {
		expect(workspacePathsEqual("/work/Project", "/work/project")).toBe(false)
	})

	it("does not match missing workspaces", () => {
		expect(workspacePathsEqual(undefined, "/work/project")).toBe(false)
	})
})
