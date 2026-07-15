import { zValidator } from "@hono/zod-validator"
import {
	designImportRuns,
	designAssets,
	designSystemVersions,
	designSystems,
	db,
	projects,
} from "@repo/db"
import { and, asc, desc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { requireCaller } from "../lib/caller"
import { canManageOrganization } from "../lib/organization-access"
import { getVisibleProject } from "../lib/project-access"
import { enqueueJob } from "../lib/background-jobs"
import { storeObject } from "../lib/local-storage"
import {
	type CandidateManifest,
	validateCandidateManifest,
} from "../lib/design-import"

export const designSystemsRoute = new Hono()

const assetSchema = z.object({
	name: z.string().trim().min(1).max(160),
	description: z.string().trim().max(4_000).optional(),
	importPath: z.string().trim().max(500).optional(),
	exportName: z
		.string()
		.trim()
		.regex(/^[A-Za-z_$][\w$]*$/, "Must be a JavaScript identifier")
		.max(160)
		.optional(),
	props: z.record(z.unknown()).default({}),
	variants: z.record(z.unknown()).default({}),
	slots: z.array(z.string().max(160)).max(100).default([]),
	examples: z.array(z.string().max(2_000)).max(20).default([]),
	accessibility: z.array(z.string().max(1_000)).max(20).default([]),
	composition: z.array(z.string().max(1_000)).max(50).default([]),
	sourceMappings: z.array(z.string().url()).max(20).default([]),
	importSource: z.record(z.unknown()).optional(),
})

export const designManifestSchema = z.object({
	schemaVersion: z.literal(1),
	name: z.string().trim().min(1).max(160),
	version: z.string().trim().min(1).max(80),
	framework: z.literal("react"),
	packageName: z.string().trim().min(1).max(240),
	preview: z.object({
		entry: z.string().trim().min(1).max(500),
		css: z.string().trim().max(500).optional(),
		peerDependencies: z.array(z.string().max(120)).max(50).default([]),
	}),
	tokens: z.array(assetSchema).max(2_000).default([]),
	primitives: z.array(assetSchema).max(2_000).default([]),
	components: z.array(assetSchema).max(2_000).default([]),
	foundations: z.array(assetSchema).max(500).default([]),
	patterns: z.array(assetSchema).max(500).default([]),
	templates: z.array(assetSchema).max(500).default([]),
	sourceMappings: z.array(z.string().url()).max(100).default([]),
	importSources: z.array(z.record(z.unknown())).max(50).default([]),
	validationProvenance: z.record(z.unknown()).default({}),
})

type DesignManifest = z.infer<typeof designManifestSchema>

async function createVersion(input: {
	designSystemId: string
	manifest: DesignManifest
	bundleUrl?: string
	createdBy: string
}) {
	return db.transaction(async (tx) => {
		const [version] = await tx
			.insert(designSystemVersions)
			.values({
				designSystemId: input.designSystemId,
				version: input.manifest.version,
				manifest: input.manifest,
				bundleUrl: input.bundleUrl,
				createdBy: input.createdBy,
			})
			.returning()
		if (!version)
			throw new Error("Design system version creation returned no row")
		const assets = [
			...input.manifest.foundations.map((asset) => ({
				kind: "foundation" as const,
				asset,
			})),
			...input.manifest.tokens.map((asset) => ({
				kind: "token" as const,
				asset,
			})),
			...input.manifest.primitives.map((asset) => ({
				kind: "primitive" as const,
				asset,
			})),
			...input.manifest.components.map((asset) => ({
				kind: "component" as const,
				asset,
			})),
			...input.manifest.patterns.map((asset) => ({
				kind: "pattern" as const,
				asset,
			})),
			...input.manifest.templates.map((asset) => ({
				kind: "template" as const,
				asset,
			})),
		]
		if (assets.length) {
			await tx.insert(designAssets).values(
				assets.map(({ kind, asset }) => ({
					versionId: version.id,
					kind,
					name: asset.name,
					description: asset.description,
					importPath: asset.importPath,
					exportName: asset.exportName,
					data: {
						props: asset.props,
						variants: asset.variants,
						slots: asset.slots,
						examples: asset.examples,
						accessibility: asset.accessibility,
						composition: asset.composition,
						sourceMappings: asset.sourceMappings,
						importSource: asset.importSource,
					},
				})),
			)
		}
		return { version, assetCount: assets.length }
	})
}

async function managedSystem(id: string, orgId: string) {
	const [system] = await db
		.select()
		.from(designSystems)
		.where(and(eq(designSystems.id, id), eq(designSystems.orgId, orgId)))
		.limit(1)
	return system
}

designSystemsRoute.get("/design-systems", async (c) => {
	const caller = await requireCaller(c)
	const systems = await db
		.select()
		.from(designSystems)
		.where(eq(designSystems.orgId, caller.orgId))
		.orderBy(asc(designSystems.name))
	return c.json({ designSystems: systems })
})

designSystemsRoute.get("/design-system-versions", async (c) => {
	const caller = await requireCaller(c)
	const versions = await db
		.select({
			id: designSystemVersions.id,
			version: designSystemVersions.version,
			name: designSystems.name,
		})
		.from(designSystemVersions)
		.innerJoin(
			designSystems,
			eq(designSystems.id, designSystemVersions.designSystemId),
		)
		.where(
			and(
				eq(designSystems.orgId, caller.orgId),
				eq(designSystemVersions.status, "active"),
			),
		)
		.orderBy(asc(designSystems.name), asc(designSystemVersions.version))
	return c.json({ versions })
})

designSystemsRoute.post(
	"/design-systems",
	zValidator(
		"json",
		z.object({
			name: z.string().trim().min(1).max(160),
			description: z.string().trim().max(4_000).optional(),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Design system owner access required" }, 403)
		}
		const [designSystem] = await db
			.insert(designSystems)
			.values({
				...c.req.valid("json"),
				orgId: caller.orgId,
				createdBy: caller.userId,
			})
			.returning()
		return c.json({ designSystem }, 201)
	},
)

designSystemsRoute.get("/design-systems/:id", async (c) => {
	const caller = await requireCaller(c)
	const [designSystem] = await db
		.select()
		.from(designSystems)
		.where(
			and(
				eq(designSystems.id, c.req.param("id")),
				eq(designSystems.orgId, caller.orgId),
			),
		)
	if (!designSystem) return c.json({ error: "Design system not found" }, 404)
	const versions = await db
		.select()
		.from(designSystemVersions)
		.where(eq(designSystemVersions.designSystemId, designSystem.id))
		.orderBy(asc(designSystemVersions.createdAt))
	return c.json({ designSystem, versions })
})

designSystemsRoute.post(
	"/design-systems/:id/versions",
	zValidator(
		"json",
		z.object({
			manifest: designManifestSchema,
			bundleUrl: z.string().url().optional(),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Design system owner access required" }, 403)
		}
		const [designSystem] = await db
			.select()
			.from(designSystems)
			.where(
				and(
					eq(designSystems.id, c.req.param("id")),
					eq(designSystems.orgId, caller.orgId),
				),
			)
		if (!designSystem) return c.json({ error: "Design system not found" }, 404)
		const { manifest, bundleUrl } = c.req.valid("json")
		if (manifest.name !== designSystem.name) {
			return c.json(
				{ error: "Manifest name must match the design system" },
				400,
			)
		}
		const issues = validateCandidateManifest(manifest as CandidateManifest)
		if (issues.length)
			return c.json({ error: "Manifest validation failed", issues }, 422)
		return c.json(
			await createVersion({
				designSystemId: designSystem.id,
				manifest,
				bundleUrl,
				createdBy: caller.userId,
			}),
			201,
		)
	},
)

designSystemsRoute.get("/design-systems/:id/imports", async (c) => {
	const caller = await requireCaller(c)
	const system = await managedSystem(c.req.param("id"), caller.orgId)
	if (!system) return c.json({ error: "Design system not found" }, 404)
	const imports = await db
		.select()
		.from(designImportRuns)
		.where(eq(designImportRuns.designSystemId, system.id))
		.orderBy(desc(designImportRuns.createdAt))
		.limit(25)
	return c.json({ imports })
})

designSystemsRoute.post("/design-systems/:id/imports/package", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Design system owner access required" }, 403)
	}
	const system = await managedSystem(c.req.param("id"), caller.orgId)
	if (!system) return c.json({ error: "Design system not found" }, 404)
	const body = await c.req.parseBody()
	const file = body.file
	if (!(file instanceof File))
		return c.json({ error: "Package archive is required" }, 400)
	if (file.size > 100 * 1024 * 1024)
		return c.json({ error: "Design archives are limited to 100 MB" }, 413)
	const object = await storeObject({
		orgId: caller.orgId,
		kind: "design_bundle",
		data: new Uint8Array(await file.arrayBuffer()),
		mimeType: file.type || "application/octet-stream",
		metadata: { fileName: file.name },
	})
	const [run] = await db
		.insert(designImportRuns)
		.values({
			designSystemId: system.id,
			createdBy: caller.userId,
			sourceType: "package",
			source: { objectId: object.id, fileName: file.name },
		})
		.returning()
	if (!run) throw new Error("Design import run creation failed")
	const job = await enqueueJob({
		orgId: caller.orgId,
		createdBy: caller.userId,
		type: "design.import",
		payload: { runId: run.id },
		idempotencyKey: run.id,
	})
	return c.json({ run, job }, 202)
})

designSystemsRoute.post(
	"/design-systems/:id/imports",
	zValidator(
		"json",
		z.discriminatedUnion("sourceType", [
			z.object({ sourceType: z.literal("storybook"), url: z.string().url() }),
			z.object({ sourceType: z.literal("figma"), fileUrl: z.string().url() }),
		]),
	),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Design system owner access required" }, 403)
		}
		const system = await managedSystem(c.req.param("id"), caller.orgId)
		if (!system) return c.json({ error: "Design system not found" }, 404)
		const input = c.req.valid("json")
		const [run] = await db
			.insert(designImportRuns)
			.values({
				designSystemId: system.id,
				createdBy: caller.userId,
				sourceType: input.sourceType,
				source: input,
			})
			.returning()
		if (!run) throw new Error("Design import run creation failed")
		const job = await enqueueJob({
			orgId: caller.orgId,
			createdBy: caller.userId,
			type: "design.import",
			payload: { runId: run.id },
			idempotencyKey: run.id,
		})
		return c.json({ run, job }, 202)
	},
)

designSystemsRoute.patch(
	"/design-imports/:id",
	zValidator("json", z.object({ manifest: designManifestSchema })),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Design system owner access required" }, 403)
		}
		const manifest = c.req.valid("json").manifest
		const issues = validateCandidateManifest(manifest as CandidateManifest)
		const [run] = await db
			.update(designImportRuns)
			.set({ candidateManifest: manifest, issues })
			.from(designSystems)
			.where(
				and(
					eq(designImportRuns.id, c.req.param("id")),
					eq(designImportRuns.designSystemId, designSystems.id),
					eq(designSystems.orgId, caller.orgId),
				),
			)
			.returning()
		if (!run) return c.json({ error: "Design import not found" }, 404)
		return c.json({ run, issues })
	},
)

designSystemsRoute.post("/design-imports/:id/create-version", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Design system owner access required" }, 403)
	}
	const [row] = await db
		.select({ run: designImportRuns, system: designSystems })
		.from(designImportRuns)
		.innerJoin(
			designSystems,
			eq(designSystems.id, designImportRuns.designSystemId),
		)
		.where(
			and(
				eq(designImportRuns.id, c.req.param("id")),
				eq(designSystems.orgId, caller.orgId),
			),
		)
		.limit(1)
	if (!row) return c.json({ error: "Design import not found" }, 404)
	if (row.run.status !== "succeeded" || !row.run.candidateManifest) {
		return c.json({ error: "Design import is not ready" }, 409)
	}
	if (row.run.issues.some((issue) => issue.severity !== "warning")) {
		return c.json({ error: "Resolve import validation errors first" }, 409)
	}
	const manifest = designManifestSchema.parse(row.run.candidateManifest)
	const issues = validateCandidateManifest(manifest as CandidateManifest)
	if (issues.length)
		return c.json({ error: "Manifest validation failed", issues }, 422)
	if (manifest.name !== row.system.name) {
		return c.json({ error: "Manifest name must match the design system" }, 400)
	}
	return c.json(
		await createVersion({
			designSystemId: row.system.id,
			manifest,
			createdBy: caller.userId,
		}),
		201,
	)
})

designSystemsRoute.post("/design-system-versions/:id/activate", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Design system owner access required" }, 403)
	}
	const [version] = await db
		.select({
			id: designSystemVersions.id,
			designSystemId: designSystemVersions.designSystemId,
			manifest: designSystemVersions.manifest,
		})
		.from(designSystemVersions)
		.innerJoin(
			designSystems,
			eq(designSystems.id, designSystemVersions.designSystemId),
		)
		.where(
			and(
				eq(designSystemVersions.id, c.req.param("id")),
				eq(designSystems.orgId, caller.orgId),
			),
		)
	if (!version) return c.json({ error: "Design system version not found" }, 404)
	const manifest = designManifestSchema.parse(version.manifest)
	const issues = validateCandidateManifest(manifest as CandidateManifest)
	if (issues.length)
		return c.json({ error: "Manifest validation failed", issues }, 422)
	await db.transaction(async (tx) => {
		await tx
			.update(designSystemVersions)
			.set({ status: "archived" })
			.where(eq(designSystemVersions.designSystemId, version.designSystemId))
		await tx
			.update(designSystemVersions)
			.set({ status: "active" })
			.where(eq(designSystemVersions.id, version.id))
	})
	return c.json({ ok: true })
})

designSystemsRoute.get("/projects/:projectId/design-assets", async (c) => {
	const caller = await requireCaller(c)
	const project = await getVisibleProject(c.req.param("projectId"), caller)
	if (!project) return c.json({ error: "Project not found" }, 404)
	if (!project.pinnedDesignSystemVersionId)
		return c.json({ version: null, assets: [] })
	const [version] = await db
		.select()
		.from(designSystemVersions)
		.innerJoin(
			designSystems,
			eq(designSystems.id, designSystemVersions.designSystemId),
		)
		.where(
			and(
				eq(designSystemVersions.id, project.pinnedDesignSystemVersionId),
				eq(designSystems.orgId, caller.orgId),
			),
		)
	if (!version)
		return c.json({ error: "Pinned design system is unavailable" }, 409)
	const assets = await db
		.select()
		.from(designAssets)
		.where(eq(designAssets.versionId, project.pinnedDesignSystemVersionId))
		.orderBy(asc(designAssets.kind), asc(designAssets.name))
	return c.json({ version: version.design_system_versions, assets })
})

designSystemsRoute.patch(
	"/projects/:projectId/design-system",
	zValidator("json", z.object({ versionId: z.string().nullable() })),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await getVisibleProject(c.req.param("projectId"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		if (project.ownerUserId !== caller.userId) {
			return c.json({ error: "Project owner access required" }, 403)
		}
		const { versionId } = c.req.valid("json")
		if (versionId) {
			const [version] = await db
				.select({ id: designSystemVersions.id })
				.from(designSystemVersions)
				.innerJoin(
					designSystems,
					eq(designSystems.id, designSystemVersions.designSystemId),
				)
				.where(
					and(
						eq(designSystemVersions.id, versionId),
						eq(designSystemVersions.status, "active"),
						eq(designSystems.orgId, caller.orgId),
					),
				)
			if (!version)
				return c.json({ error: "Active design system version not found" }, 404)
		}
		const [updated] = await db
			.update(projects)
			.set({ pinnedDesignSystemVersionId: versionId, updatedAt: new Date() })
			.where(eq(projects.id, project.id))
			.returning()
		return c.json({ project: updated })
	},
)
