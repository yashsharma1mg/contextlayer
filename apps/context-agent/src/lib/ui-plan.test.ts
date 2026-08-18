import { expect, test } from "bun:test"
import {
	uiPlanSchema,
	uiPlanStateWarnings,
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

test("a sparse plan is generated, not rejected", () => {
	// Previously all eight of permission/loading/empty/validation/error/retry/
	// quota/recovery had to appear or the plan was rejected outright, which
	// killed most otherwise-valid screens. Design-system integrity is what
	// blocks; state coverage only advises.
	const plan = uiPlanSchema.parse({
		title: "Settings",
		summary: "Manage preferences.",
		screens: [
			{ name: "Settings", purpose: "Preferences", states: ["default"] },
		],
		navigation: [],
		components: [{ componentId: "Button", props: {}, variants: {} }],
		tokens: [],
		fileStructure: ["Settings.tsx"],
	})
	const assets = [
		{ name: "Button", kind: "component", data: { props: { label: {} } } },
	]

	expect(validateUiPlan(plan, assets)).toEqual([])
	expect(uiPlanStateWarnings(plan)).toEqual([
		"No permission state described",
		"No loading state described",
		"No empty state described",
		"No validation state described",
		"No error state described",
		"No retry state described",
		"No quota state described",
		"No recovery state described",
	])
})

test("a thorough plan warns about nothing", () => {
	const plan = uiPlanSchema.parse({
		title: "Settings",
		summary: "",
		screens: [
			{
				name: "Settings",
				purpose: "",
				states: [
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
		components: [],
		tokens: [],
		fileStructure: ["src/App.tsx"],
	})
	expect(uiPlanStateWarnings(plan)).toEqual([])
})

test("a nested unapproved component is still rejected", () => {
	// The emitter walks children, so validation must too — otherwise an
	// unapproved component hides one level down and reaches generated source.
	const plan = uiPlanSchema.parse({
		title: "Settings",
		summary: "",
		screens: [{ name: "Settings", purpose: "", states: ["default"] }],
		navigation: [],
		components: [
			{
				componentId: "Stack",
				props: {},
				variants: {},
				children: [{ componentId: "SketchyThing", props: {}, variants: {} }],
			},
		],
		tokens: [],
		fileStructure: ["src/App.tsx"],
	})
	expect(
		validateUiPlan(plan, [{ name: "Stack", kind: "primitive", data: {} }]),
	).toEqual(["Unapproved component: SketchyThing"])
})
