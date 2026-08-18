import { expect, test } from "bun:test"
import { reactFilesFromUiPlan, reactSourceFromUiPlan } from "./react-source"
import type { ApprovedDesignAsset, UiPlan } from "./ui-plan"

const assets: ApprovedDesignAsset[] = [
	{
		id: "a1",
		name: "Stack",
		kind: "primitive",
		data: { importPath: "@acme/ds", exportName: "Stack", props: { gap: {} } },
	},
	{
		id: "a2",
		name: "Button",
		kind: "component",
		data: {
			importPath: "@acme/ds",
			exportName: "Button",
			props: {},
			variants: { tone: {} },
		},
	},
]

function plan(components: UiPlan["components"]): UiPlan {
	return {
		title: "Settings",
		summary: "Settings screen",
		manifestVersionId: "v1",
		targetFramework: "vite",
		screens: [
			{
				name: "Settings",
				purpose: "settings",
				route: "/",
				states: ["default"],
			},
		],
		navigation: [],
		components,
		tokens: [],
		citations: [],
		fileStructure: ["src/App.tsx"],
	}
}

test("nests children inside their parent instead of flattening them", () => {
	const source = reactSourceFromUiPlan(
		plan([
			{
				componentId: "Stack",
				props: { gap: 8 },
				variants: {},
				children: [
					{ componentId: "Button", props: {}, variants: { tone: "primary" } },
				],
			},
		]),
		assets,
	)

	// The regression this guards: the emitter used to drop children entirely and
	// emit every component as a sibling self-closing tag.
	expect(source).toContain("<Stack")
	expect(source).toContain("</Stack>")
	expect(source.indexOf("<Button")).toBeGreaterThan(source.indexOf("<Stack"))
	expect(source.indexOf("<Button")).toBeLessThan(source.indexOf("</Stack>"))
})

test("a component used twice is imported once", () => {
	const source = reactSourceFromUiPlan(
		plan([
			{
				componentId: "Stack",
				props: {},
				variants: {},
				children: [
					{ componentId: "Button", props: {}, variants: {} },
					{ componentId: "Button", props: {}, variants: {} },
				],
			},
		]),
		assets,
	)
	const imports = source
		.split("\n")
		.filter((line) => line.startsWith("import ") && line.includes("Button"))
	expect(imports).toHaveLength(1)
})

test("leaf text is emitted as an expression so copy cannot break the JSX", () => {
	const source = reactSourceFromUiPlan(
		plan([
			{
				componentId: "Button",
				props: {},
				variants: {},
				text: 'Save & "exit" <now>',
			},
		]),
		assets,
	)
	expect(source).toContain(JSON.stringify('Save & "exit" <now>'))
	expect(source).toContain("</Button>")
})

test("a component with neither children nor text stays self-closing", () => {
	const source = reactSourceFromUiPlan(
		plan([{ componentId: "Button", props: {}, variants: {} }]),
		assets,
	)
	expect(source).toContain("<Button />")
	expect(source).not.toContain("</Button>")
})

test("an unmapped component fails loudly rather than emitting a bad import", () => {
	expect(() =>
		reactSourceFromUiPlan(
			plan([{ componentId: "Ghost", props: {}, variants: {} }]),
			assets,
		),
	).toThrow(/Missing import mapping for Ghost/)
})

test("nested children inherit their parent's screen when files are split", () => {
	const multi = plan([
		{
			componentId: "Stack",
			screen: "Settings",
			props: {},
			variants: {},
			children: [{ componentId: "Button", props: {}, variants: {} }],
		},
	])
	multi.screens = [
		{ name: "Settings", purpose: "s", route: "/", states: ["default"] },
		{ name: "Billing", purpose: "b", route: "/billing", states: ["default"] },
	]
	const files = reactFilesFromUiPlan(multi, assets)

	const settings = files.find((f) => f.path.includes("SettingsScreen"))
	const billing = files.find((f) => f.path.includes("BillingScreen"))
	// The child has no `screen` of its own; it must follow its parent rather
	// than leaking onto every screen.
	expect(settings?.content).toContain("<Button")
	expect(billing?.content).not.toContain("<Button")
})
