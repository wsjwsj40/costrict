import type OpenAI from "openai"

import { TOOL_ALIASES } from "../../../shared/tools"

type FunctionTool = OpenAI.Chat.ChatCompletionFunctionTool
type JsonSchema = Record<string, any>

export interface ToolValidationIssue {
	path: string
	code: "required" | "type" | "enum" | "additional_property"
	message: string
}

export type ToolResolution =
	| { ok: true; name: string; originalName?: string; tool: FunctionTool }
	| { ok: false; requestedName: string; suggestions: string[] }

export type ToolArgumentsValidation =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; issues: ToolValidationIssue[] }

function functionTool(tool: OpenAI.Chat.ChatCompletionTool): tool is FunctionTool {
	return tool.type === "function" && "function" in tool
}

function valueType(value: unknown): string {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	return typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value
}

function acceptsType(schema: JsonSchema, value: unknown): boolean {
	if (!schema.type) return true
	const accepted = Array.isArray(schema.type) ? schema.type : [schema.type]
	const actual = valueType(value)
	return accepted.includes(actual) || (actual === "integer" && accepted.includes("number"))
}

function validateSchema(schema: JsonSchema, value: unknown, path: string, issues: ToolValidationIssue[]): void {
	if (!acceptsType(schema, value)) {
		issues.push({
			path,
			code: "type",
			message: `Expected ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}, received ${valueType(value)}.`,
		})
		return
	}

	if (schema.enum && !schema.enum.includes(value)) {
		issues.push({ path, code: "enum", message: `Expected one of: ${schema.enum.join(", ")}.` })
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const objectValue = value as Record<string, unknown>
		const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
		for (const required of (schema.required ?? []) as string[]) {
			if (objectValue[required] === undefined) {
				issues.push({
					path: path ? `${path}.${required}` : required,
					code: "required",
					message: "Required parameter is missing.",
				})
			}
		}
		for (const [key, child] of Object.entries(objectValue)) {
			const childSchema = properties[key]
			const childPath = path ? `${path}.${key}` : key
			if (!childSchema) {
				if (schema.additionalProperties === false) {
					issues.push({ path: childPath, code: "additional_property", message: "Unknown parameter." })
				}
				continue
			}
			validateSchema(childSchema, child, childPath, issues)
		}
	}

	if (Array.isArray(value) && schema.items) {
		value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, issues))
	}
}

function applyDeterministicDefaults(schema: JsonSchema, value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value
	const result = { ...(value as Record<string, unknown>) }
	const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
	for (const [key, childSchema] of Object.entries(properties)) {
		if (result[key] === undefined) {
			if (childSchema.default !== undefined) result[key] = childSchema.default
			else if (Array.isArray(childSchema.type) && childSchema.type.includes("null")) result[key] = null
		}
		if (result[key] !== undefined) result[key] = applyDeterministicDefaults(childSchema, result[key])
	}
	return result
}

function editDistance(left: string, right: string): number {
	const rows = Array.from({ length: left.length + 1 }, (_, index) => index)
	for (let i = 1; i <= right.length; i++) {
		let previous = rows[0]
		rows[0] = i
		for (let j = 1; j <= left.length; j++) {
			const current = rows[j]
			rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (left[j - 1] === right[i - 1] ? 0 : 1))
			previous = current
		}
	}
	return rows[left.length]
}

/**
 * Exact-name registry for the tool definitions sent to the model. The same JSON
 * schema is used for runtime validation, so model-visible and executable contracts
 * cannot silently diverge.
 */
export class ToolRegistry {
	private readonly tools = new Map<string, FunctionTool>()
	private readonly aliases = new Map<string, string>()

	constructor(tools: OpenAI.Chat.ChatCompletionTool[], aliases: Record<string, string> = TOOL_ALIASES) {
		for (const tool of tools) {
			if (!functionTool(tool)) continue
			const name = tool.function.name
			if (this.tools.has(name)) throw new Error(`Duplicate tool definition: ${name}`)
			this.tools.set(name, tool)
		}
		for (const [alias, canonical] of Object.entries(aliases)) {
			if (this.tools.has(alias) && alias !== canonical) {
				throw new Error(`Tool alias '${alias}' conflicts with a canonical tool name.`)
			}
			if (this.tools.has(canonical)) this.aliases.set(alias, canonical)
		}
	}

	list(): FunctionTool[] {
		return [...this.tools.values()]
	}

	resolve(requestedName: string): ToolResolution {
		const exact = this.tools.get(requestedName)
		if (exact) return { ok: true, name: requestedName, tool: exact }

		const canonical = this.aliases.get(requestedName)
		const aliased = canonical ? this.tools.get(canonical) : undefined
		if (canonical && aliased) return { ok: true, name: canonical, originalName: requestedName, tool: aliased }

		return { ok: false, requestedName, suggestions: this.suggest(requestedName) }
	}

	validate(name: string, args: unknown): ToolArgumentsValidation {
		const resolution = this.resolve(name)
		if (!resolution.ok) {
			return {
				ok: false,
				issues: [
					{
						path: "name",
						code: "enum",
						message: `Unknown tool. Suggestions: ${resolution.suggestions.join(", ") || "none"}.`,
					},
				],
			}
		}
		const schema = (resolution.tool.function.parameters ?? { type: "object" }) as JsonSchema
		const repaired = applyDeterministicDefaults(schema, args)
		const issues: ToolValidationIssue[] = []
		validateSchema(schema, repaired, "", issues)
		return issues.length ? { ok: false, issues } : { ok: true, value: (repaired ?? {}) as Record<string, unknown> }
	}

	private suggest(requestedName: string): string[] {
		return [...this.tools.keys()]
			.map((name) => ({ name, distance: editDistance(requestedName, name) }))
			.filter(({ name, distance }) => distance <= Math.max(2, Math.floor(name.length / 3)))
			.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
			.slice(0, 3)
			.map(({ name }) => name)
	}
}

export function formatToolValidationError(tool: string, issues: ToolValidationIssue[]): string {
	return JSON.stringify({
		error: "INVALID_TOOL_ARGUMENTS",
		tool,
		issues,
		instruction: "Retry with corrected arguments. Do not repeat the unchanged invalid call.",
		retryable: true,
	})
}
