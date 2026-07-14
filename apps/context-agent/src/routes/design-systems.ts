import { zValidator } from "@hono/zod-validator"
import {
	designAssets,
	designSystemVersions,
	designSystems,
	db,
	projects,
} from "@repo/db"
import { and, asc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { requireCaller } from "../lib/caller"
import { getVisibleProject } from "../lib/project-access"

export const designSystemsRoute = new Hono()

const assetSchema = z.object({
	name: z.string().trim().min(1).max(160),
	description: z.string().trim().max(4_000).optional(),
	importPath: z.string().trim().max(500).optional(),
	exportName: z.string().trim().max(160).optional(),
	props: z.record(z.unknown()).default({}),
	variants: z.record(z.unknown()).default({}),
	examples: z.array(z.string().max(2_000)).max(20).default([]),
	accessibility: z.array(z.string().max(1_000)).max(20).default([]),
	sourceMappings: z.array(z.string().url()).max(20).default([]),
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
})

function canManageDesignSystem(role: string) {
	return role === "owner" || role === "admin"
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
		if (!canManageDesignSystem(caller.role)) {
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
		if (!canManageDesignSystem(caller.role)) {
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
		const [version] = await db
			.insert(designSystemVersions)
			.values({
				designSystemId: designSystem.id,
				version: manifest.version,
				manifest,
				bundleUrl,
				createdBy: caller.userId,
			})
			.returning()
		if (!version)
			throw new Error("Design system version creation returned no row")

		const assets = [
			...manifest.foundations.map((asset) => ({
				kind: "foundation" as const,
				asset,
			})),
			...manifest.tokens.map((asset) => ({ kind: "token" as const, asset })),
			...manifest.primitives.map((asset) => ({
				kind: "primitive" as const,
				asset,
			})),
			...manifest.components.map((asset) => ({
				kind: "component" as const,
				asset,
			})),
			...manifest.patterns.map((asset) => ({
				kind: "pattern" as const,
				asset,
			})),
			...manifest.templates.map((asset) => ({
				kind: "template" as const,
				asset,
			})),
		]
		if (assets.length) {
			await db.insert(designAssets).values(
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
						examples: asset.examples,
						accessibility: asset.accessibility,
						sourceMappings: asset.sourceMappings,
					},
				})),
			)
		}
		return c.json({ version, assetCount: assets.length }, 201)
	},
)

designSystemsRoute.post("/design-system-versions/:id/activate", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageDesignSystem(caller.role)) {
		return c.json({ error: "Design system owner access required" }, 403)
	}
	const [version] = await db
		.select({
			id: designSystemVersions.id,
			designSystemId: designSystemVersions.designSystemId,
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
