import { expect, test } from "bun:test"
import { uiPlanSchema, validateUiPlan } from "./ui-plan"

test("rejects unapproved design-system details", () => {
	const plan = uiPlanSchema.parse({
		title: "Settings",
		summary: "Manage preferences.",
		screens: [
			{ name: "Settings", purpose: "Preferences", states: ["default"] },
		],
		navigation: [],
		components: [
			{ componentId: "Button", props: { madeUp: true }, variants: {} },
		],
		tokens: ["missing"],
		fileStructure: ["Settings.tsx"],
	})
	const errors = validateUiPlan(plan, [
		{ name: "Button", kind: "component", data: { props: { label: {} } } },
	])
	expect(errors).toEqual([
		"Unknown prop madeUp on Button",
		"Unapproved token: missing",
	])
})
