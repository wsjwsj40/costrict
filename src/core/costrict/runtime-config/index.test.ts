import { describe, expect, it } from "vitest"

import { canReuseCompletionService } from "./index"

describe("canReuseCompletionService", () => {
	it("rejects a stale running service entry when no process exists", () => {
		expect(
			canReuseCompletionService(
				{
					name: "completion-agent",
					port: 9002,
					status: "running",
				},
				[],
			),
		).toBe(false)
	})

	it("reuses a running service entry when its process exists", () => {
		expect(
			canReuseCompletionService(
				{
					name: "completion-agent",
					port: 9002,
					status: "running",
				},
				[1234],
			),
		).toBe(true)
	})

	it("rejects an explicitly stopped service", () => {
		expect(
			canReuseCompletionService(
				{
					name: "completion-agent",
					port: 9002,
					status: "stopped",
				},
				[1234],
			),
		).toBe(false)
	})
})
