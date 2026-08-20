import { describe, expect, it } from "vitest"

import { ToolRegistry } from "../ToolRegistry"

const tools = [
	{
		type: "function" as const,
		function: {
			name: "read_file",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					limit: { type: ["integer", "null"] },
				},
				required: ["path", "limit"],
				additionalProperties: false,
			},
		},
	},
]

describe("ToolRegistry", () => {
	it("resolves only exact names and explicit aliases", () => {
		const registry = new ToolRegistry(tools, { read: "read_file" })
		expect(registry.resolve("read_file")).toMatchObject({ ok: true, name: "read_file" })
		expect(registry.resolve("read")).toMatchObject({ ok: true, name: "read_file", originalName: "read" })
		expect(registry.resolve("please_read_file")).toMatchObject({ ok: false })
	})

	it("uses the model-visible schema for field-level validation", () => {
		const registry = new ToolRegistry(tools)
		const validation = registry.validate("read_file", { limit: 20 })
		expect(validation).toMatchObject({
			ok: false,
			issues: [{ path: "path", code: "required" }],
		})
	})

	it("repairs missing nullable parameters deterministically", () => {
		const registry = new ToolRegistry(tools)
		expect(registry.validate("read_file", { path: "src/app.ts" })).toEqual({
			ok: true,
			value: { path: "src/app.ts", limit: null },
		})
	})

	it("rejects unknown properties", () => {
		const registry = new ToolRegistry(tools)
		const validation = registry.validate("read_file", { path: "src/app.ts", limit: null, filename: "x" })
		expect(validation).toMatchObject({
			ok: false,
			issues: [{ path: "filename", code: "additional_property" }],
		})
	})
})
