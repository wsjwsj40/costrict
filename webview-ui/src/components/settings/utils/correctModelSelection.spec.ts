// npx vitest run src/components/settings/utils/correctModelSelection.spec.ts

import { describe, it, expect } from "vitest"

import { getCorrectedCostrictModelId } from "./correctModelSelection"

describe("getCorrectedCostrictModelId", () => {
	it("returns the first server model when no model is selected", () => {
		expect(getCorrectedCostrictModelId(["qwen-plus", "qwen-max"], undefined)).toBe("qwen-plus")
	})

	it("returns the first server model when the initial selection is not authorized", () => {
		expect(getCorrectedCostrictModelId(["qwen-plus"], "Auto")).toBe("qwen-plus")
	})

	it("returns the first server model for a selection outside the permission list", () => {
		expect(getCorrectedCostrictModelId(["qwen-plus"], "my-private-model")).toBe("qwen-plus")
	})

	it("returns null when the selected model is still in the new list", () => {
		expect(getCorrectedCostrictModelId(["qwen-plus", "qwen-max"], "qwen-max")).toBeNull()
	})

	it("returns the first new model when the selected model was removed", () => {
		expect(getCorrectedCostrictModelId(["qwen-plus", "qwen-turbo"], "qwen-max")).toBe("qwen-plus")
	})

	it("returns null when the new list is empty (nothing to fall back to)", () => {
		expect(getCorrectedCostrictModelId([], "qwen-max")).toBeNull()
	})

	it("returns the first model when the selected model is an empty string", () => {
		expect(getCorrectedCostrictModelId(["qwen-plus"], "")).toBe("qwen-plus")
	})

	it("returns null when the permission list is empty", () => {
		expect(getCorrectedCostrictModelId([], "my-custom")).toBeNull()
	})
})
