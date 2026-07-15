import { expect, test } from "bun:test"
import {
	type CandidateManifest,
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
