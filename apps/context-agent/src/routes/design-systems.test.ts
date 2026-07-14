import { expect, test } from "bun:test"

test("accepts primitive and template design assets", async () => {
	process.env.DATABASE_URL ??=
		"postgres://contextlayer:contextlayer@localhost:5432/contextlayer"
	process.env.BETTER_AUTH_URL ??= "http://localhost:8787"
	const { designManifestSchema } = await import("./design-systems")
	const manifest = designManifestSchema.parse({
		schemaVersion: 1,
		name: "Acme UI",
		version: "1.0.0",
		framework: "react",
		packageName: "@acme/ui",
		preview: { entry: "./src/index.tsx" },
		primitives: [{ name: "Stack" }],
		templates: [{ name: "Settings page" }],
	})

	expect(manifest.primitives).toHaveLength(1)
	expect(manifest.templates).toHaveLength(1)
})
