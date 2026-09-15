import { describe, expect, it } from "vitest"
import { DEFAULT_MODES } from "@roo-code/types"
import { filterModesByCostrictCodeMode, getModeBySlug, getToolsForMode } from "../modes"

describe("workflow mode boundaries", () => {
	it("exposes only the Planner agent in Plan", () => {
		const planModes = filterModesByCostrictCodeMode([...DEFAULT_MODES], "plan", "costrict")
		expect(planModes.map((mode) => mode.slug)).toEqual(["plan"])
	})

	it("does not advertise generic write or command tools in Plan", () => {
		const plan = getModeBySlug("plan")
		expect(plan?.groups).toEqual(["read"])
		expect(getToolsForMode(plan?.groups ?? [])).not.toContain("write_to_file")
		expect(getToolsForMode(plan?.groups ?? [])).not.toContain("execute_command")
	})
})
