import { describe, expect, it } from "vitest"

import { isForbiddenModelRequest, selectPermissionReplacementModel } from "../modelPermissionRecovery"

describe("model permission recovery", () => {
	it("recognizes common forbidden error shapes", () => {
		expect(isForbiddenModelRequest({ status: 403 })).toBe(true)
		expect(isForbiddenModelRequest({ response: { status: 403 } })).toBe(true)
		expect(isForbiddenModelRequest({ cause: { status: "403" } })).toBe(true)
		expect(isForbiddenModelRequest({ status: 401 })).toBe(false)
	})

	it("uses the first server model only when the current model disappeared", () => {
		const models = { free1: {}, free2: {} } as any
		expect(selectPermissionReplacementModel(models, "pro1")).toBe("free1")
		expect(selectPermissionReplacementModel(models, "free2")).toBeUndefined()
		expect(selectPermissionReplacementModel({}, "pro1")).toBeUndefined()
	})
})
