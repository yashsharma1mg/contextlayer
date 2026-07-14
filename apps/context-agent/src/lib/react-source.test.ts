import { expect, test } from "bun:test"
import { reactSourceFromUiPlan } from "./react-source"
import { validateGeneratedFiles } from "./prototype-validation"
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

test("rejects bare and dynamic imports outside the approved design system", () => {
	const errors = validateGeneratedFiles(
		[
			{
				path: "src/App.tsx",
				content:
					'import "unapproved/reset.css"; export default async function App() { await import("unapproved/runtime"); return null }',
			},
		],
		["@approved/system"],
	)
	expect(errors).toContain(
		"Unapproved import unapproved/reset.css in src/App.tsx",
	)
	expect(errors).toContain(
		"Unapproved import unapproved/runtime in src/App.tsx",
	)
})
