import { expect, test } from "bun:test"
import { reactSourceFromUiPlan } from "./react-source"
import { uiPlanSchema } from "./ui-plan"

test("creates React source from approved component imports", () => {
	const plan = uiPlanSchema.parse({
		title: "Settings <Admin>",
		summary: "",
		screens: [{ name: "Settings", purpose: "", states: ["default"] }],
		navigation: [],
		components: [
			{ componentId: "Button", props: { label: "Save" }, variants: {} },
		],
		tokens: [],
		fileStructure: ["Settings.tsx"],
	})
	expect(
		reactSourceFromUiPlan(plan, [
			{
				name: "Button",
				kind: "component",
				data: { importPath: "@acme/ui", exportName: "Button" },
			},
		]),
	).toContain('import { Button as Button } from "@acme/ui"')
	expect(
		reactSourceFromUiPlan(plan, [
			{
				name: "Button",
				kind: "component",
				data: { importPath: "@acme/ui", exportName: "Button" },
			},
		]),
	).toContain('<h1>{"Settings <Admin>"}</h1>')
})
