import { describe, expect, it } from "vitest"

import { parseUpdateManifest, validateUpdateUrls } from "../manifest"

const validManifest = {
	version: "3.1.0",
	sha256: "a".repeat(64),
}

describe("update manifest", () => {
	it("accepts a valid manifest", () => {
		expect(parseUpdateManifest(validManifest)).toEqual(validManifest)
	})

	it("rejects an invalid checksum", () => {
		expect(() => parseUpdateManifest({ ...validManifest, sha256: "bad" })).toThrow()
	})

	it("requires HTTPS by default", () => {
		expect(() =>
			validateUpdateUrls(
				"http://updates.example.internal/latest.json",
				"http://updates.example.internal/dicode.vsix",
				false,
			),
		).toThrow("must use HTTPS")
	})

	it("allows explicitly enabled HTTP on the same origin", () => {
		expect(() =>
			validateUpdateUrls(
				"http://updates.example.internal/latest.json",
				"http://updates.example.internal/dicode.vsix",
				true,
			),
		).not.toThrow()
	})

	it("rejects a download hosted on another origin", () => {
		expect(() =>
			validateUpdateUrls(
				"https://updates.example.internal/latest.json",
				"https://untrusted.example.net/dicode.vsix",
				false,
			),
		).toThrow("same origin")
	})
})
