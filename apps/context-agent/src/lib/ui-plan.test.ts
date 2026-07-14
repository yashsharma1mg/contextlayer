import { expect, test } from "bun:test"
import {
	uiPlanSchema,
	validateUiPlan,
	validateUiPlanCitations,
} from "./ui-plan"

test("rejects unapproved design-system details", () => {
	const plan = uiPlanSchema.parse({
		title: "Settings",
		summary: "Manage preferences.",
		screens: [
			{
				name: "Settings",
				purpose: "Preferences",
				states: [
					"default",
					"permission denied",
					"loading",
					"empty",
					"validation error",
					"error with retry",
					"quota exceeded",
					"recovery",
				],
			},
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

test("rejects invented or missing required citations", () => {
	const plan = uiPlanSchema.parse({
		title: "Settings",
		summary: "",
		screens: [{ name: "Settings", purpose: "", states: ["default"] }],
		navigation: [],
		components: [],
		tokens: [],
		fileStructure: ["src/App.tsx"],
		citations: [{ documentId: "invented", title: "Invented" }],
	})
	expect(
		validateUiPlanCitations(plan, [{ documentId: "real" }], { required: true }),
	).toEqual(["Unavailable citation: invented"])
	expect(
		validateUiPlanCitations({ ...plan, citations: [] }, [], { required: true }),
	).toEqual(["At least one accessible knowledge citation is required"])
})
