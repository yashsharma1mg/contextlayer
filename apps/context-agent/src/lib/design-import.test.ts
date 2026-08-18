import { expect, test } from "bun:test"
import {
	type CandidateManifest,
	componentPropTypes,
	mergeCandidateManifests,
	safeArchivePath,
	validatePackageSource,
	validateCandidateManifest,
} from "./design-import"

function manifest(source: Record<string, unknown>): CandidateManifest {
	return {
		schemaVersion: 1,
		name: "System",
		version: "1.0.0",
		framework: "react",
		packageName: "@example/system",
		preview: { entry: "./index.js", peerDependencies: ["react"] },
		foundations: [],
		tokens: [],
		primitives: [],
		components: [],
		patterns: [],
		templates: [],
		sourceMappings: [],
		importSources: [source],
		validationProvenance: {},
	}
}

test("merges package mappings with Storybook examples", () => {
	const code = manifest({ type: "package", objectId: "object-1" })
	code.components.push({
		name: "Button",
		importPath: "@example/system",
		exportName: "Button",
	})
	const stories = manifest({ type: "storybook", url: "https://example.com" })
	stories.components.push({ name: "Button", examples: ["Primary"] })

	const result = mergeCandidateManifests(code, stories)
	expect(result.manifest.components[0]).toMatchObject({
		name: "Button",
		importPath: "@example/system",
		exportName: "Button",
		examples: ["Primary"],
	})
	expect(result.issues).toEqual([])
})

test("blocks activation until imported UI assets have code mappings", () => {
	const draft = manifest({ type: "figma", fileKey: "file-1" })
	draft.components.push({ name: "Button" })
	expect(validateCandidateManifest(draft)).toEqual([
		expect.objectContaining({ path: "components.Button" }),
	])
})

test("rejects archive traversal paths", () => {
	expect(safeArchivePath("package/src/index.ts")).toBe(true)
	expect(safeArchivePath("package/../../Library/secret")).toBe(false)
	expect(safeArchivePath("/tmp/secret")).toBe(false)
})

test("rejects executable package macros and unbounded loops", () => {
	expect(() =>
		validatePackageSource(
			"src/component.tsx",
			'import macro from "./macro" with { type: "macro" }',
		),
	).toThrow("build-time macros")
	expect(() =>
		validatePackageSource("src/component.tsx", "while (true) {}"),
	).toThrow("unbounded loops")
})

const dts = `
export declare const Button: React.FC<ButtonProps>;
export interface ButtonProps {
  label: string;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger";
  onClick?: () => void;
}
export type CardProps = {
  title: string
  footer?: React.ReactNode
  size?: 'sm' | 'lg'
}
`

test("reads declared prop names off a .d.ts", () => {
	const found = componentPropTypes([{ path: "index.d.ts", text: dts }])
	// Without this, design_assets.data.props stays empty and validateUiPlan
	// checks generated plans against an empty allowlist.
	expect(Object.keys(found.get("Button")?.props ?? {}).sort()).toEqual([
		"disabled",
		"label",
		"onClick",
	])
})

test("a string-literal union becomes a variant with its allowed values", () => {
	const found = componentPropTypes([{ path: "index.d.ts", text: dts }])
	expect(found.get("Button")?.variants.tone).toEqual([
		"primary",
		"secondary",
		"danger",
	])
	// Single quotes too — declaration output is not normalised.
	expect(found.get("Card")?.variants.size).toEqual(["sm", "lg"])
})

test("handles `type X = {}` as well as `interface X {}`", () => {
	const found = componentPropTypes([{ path: "index.d.ts", text: dts }])
	expect(Object.keys(found.get("Card")?.props ?? {}).sort()).toEqual([
		"footer",
		"title",
	])
})

test("a nested object type does not split into bogus members", () => {
	const found = componentPropTypes([
		{
			path: "a.d.ts",
			text: `interface PanelProps {
				header: { title: string; subtitle?: string };
				open?: boolean;
			}`,
		},
	])
	// The brace-depth scanner must keep the inline object as one member rather
	// than leaking title and subtitle up as Panel's own props.
	expect(Object.keys(found.get("Panel")?.props ?? {}).sort()).toEqual([
		"header",
		"open",
	])
})

test("an unbalanced declaration is skipped rather than throwing", () => {
	const found = componentPropTypes([
		{ path: "broken.d.ts", text: "interface BrokenProps { a: string;" },
	])
	expect(found.get("Broken")).toBeUndefined()
})
