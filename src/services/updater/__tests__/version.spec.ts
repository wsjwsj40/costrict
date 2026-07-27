import { describe, expect, it } from "vitest"

import { isBelowMinimum, isNewerVersion, normalizeVersion } from "../version"

describe("updater version helpers", () => {
	it("normalizes a leading v", () => {
		expect(normalizeVersion("v3.1.0")).toBe("3.1.0")
	})

	it("detects newer semantic versions", () => {
		expect(isNewerVersion("3.1.0", "3.0.16")).toBe(true)
		expect(isNewerVersion("3.0.16", "3.0.16")).toBe(false)
		expect(isNewerVersion("3.0.15", "3.0.16")).toBe(false)
		expect(isNewerVersion("3.1.0", "3.1.0-beta.2")).toBe(true)
		expect(isNewerVersion("3.1.0-beta.10", "3.1.0-beta.2")).toBe(true)
	})

	it("detects versions below the server minimum", () => {
		expect(isBelowMinimum("3.0.16", "3.1.0")).toBe(true)
		expect(isBelowMinimum("3.1.0", "3.1.0")).toBe(false)
		expect(isBelowMinimum("3.1.0")).toBe(false)
	})

	it("rejects malformed versions", () => {
		expect(() => normalizeVersion("latest")).toThrow("Invalid semantic version")
	})
})
