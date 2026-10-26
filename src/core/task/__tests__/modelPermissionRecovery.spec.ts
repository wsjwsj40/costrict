import { describe, expect, it } from "vitest"

import {
	describeModelPermissionError,
	isForbiddenModelRequest,
	selectPermissionReplacementModel,
} from "../modelPermissionRecovery"

describe("model permission recovery", () => {
	it("recognizes common forbidden error shapes", () => {
		expect(isForbiddenModelRequest({ status: 403 })).toBe(true)
		expect(isForbiddenModelRequest({ response: { status: 403 } })).toBe(true)
		expect(isForbiddenModelRequest({ cause: { status: "403" } })).toBe(true)
		expect(isForbiddenModelRequest({ statusCode: 403 })).toBe(true)
		expect(isForbiddenModelRequest(new Error("Code: 403\nMessage: forbidden"))).toBe(true)
		expect(isForbiddenModelRequest({ status: 401 })).toBe(false)
		expect(isForbiddenModelRequest(new Error("request 4032 failed"))).toBe(false)
	})

	it("describes useful error fields for extension-host diagnostics", () => {
		const error = Object.assign(new Error("forbidden"), { status: 403, code: "permission_denied" })
		expect(describeModelPermissionError(error)).toContain('"status":403')
		expect(describeModelPermissionError(error)).toContain('"message":"forbidden"')
	})

	it("uses the first server model only when the current model disappeared", () => {
		const models = { free1: {}, free2: {} } as any
		expect(selectPermissionReplacementModel(models, "pro1")).toBe("free1")
		expect(selectPermissionReplacementModel(models, "free2")).toBeUndefined()
		expect(selectPermissionReplacementModel({}, "pro1")).toBeUndefined()
	})
})
