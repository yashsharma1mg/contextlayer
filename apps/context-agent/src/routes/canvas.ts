import { zValidator } from "@hono/zod-validator"
import {
	artifactRevisions,
	canvasComments,
	canvasEdges,
	canvasNodes,
	canvasRevisions,
	canvases,
	captures,
	captureTokens,
	db,
	designAssets,
	documents,
	ideas,
	projectShareLinks,
	projects,
} from "@repo/db"
import { generateObject } from "ai"
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { createHash, randomBytes } from "node:crypto"
import { requireCaller } from "../lib/caller"
import { documentVisibility } from "../lib/access-policy"
import { generateUi } from "../lib/generate-ui"
import { openrouter, withModelFallback } from "../lib/openrouter"
import { getVisibleProject } from "../lib/project-access"
import { searchMemories } from "../lib/search"

export const canvasRoute = new Hono()

const edgeKindSchema = z.enum([
	"derived_from",
	"supports",
	"contradicts",
	"flows_to",
	"implements",
	"references",
])

const canvasSnapshotSchema = z.object({
	nodes: z.array(
		z.object({
			id: z.string(),
			canvasId: z.string(),
			kind: z.enum([
				"artifact",
				"knowledge",
				"capture",
				"design_asset",
				"note",
				"frame",
			]),
			artifactId: z.string().nullable(),
			documentId: z.string().nullable(),
			captureId: z.string().nullable(),
			designAssetId: z.string().nullable(),
			label: z.string(),
			x: z.number().int(),
			y: z.number().int(),
			width: z.number().int(),
			height: z.number().int(),
			zIndex: z.number().int(),
			version: z.number().int().positive(),
			data: z.record(z.unknown()),
		}),
	),
	edges: z.array(
		z.object({
			id: z.string(),
			canvasId: z.string(),
			sourceNodeId: z.string(),
			targetNodeId: z.string(),
			kind: edgeKindSchema,
			label: z.string().nullable(),
		}),
	),
	comments: z.array(
		z.object({
			id: z.string(),
			canvasId: z.string(),
			nodeId: z.string().nullable(),
			authorUserId: z.string(),
			body: z.string(),
		}),
	),
})

async function canvasForProject(projectId: string) {
	const [existing] = await db
		.select()
		.from(canvases)
		.where(eq(canvases.projectId, projectId))
		.orderBy(asc(canvases.createdAt))
		.limit(1)
	if (existing) return existing
	const [created] = await db
		.insert(canvases)
		.values({ projectId, name: "Workspace" })
		.returning()
	if (!created) throw new Error("Canvas creation returned no row")
	return created
}

async function visibleCanvas(
	canvasId: string,
	userId: string,
	orgId: string,
	teamIds: string[],
) {
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(eq(canvases.id, canvasId))
		.limit(1)
	if (!canvas) return null
	const project = await getVisibleProject(canvas.projectId, {
		userId,
		orgId,
		teamIds,
		role: "member",
	})
	return project ? { canvas, project } : null
}

async function snapshot(canvasId: string) {
	const [nodes, edges, comments] = await Promise.all([
		db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvasId)),
		db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)),
		db
			.select()
			.from(canvasComments)
			.where(eq(canvasComments.canvasId, canvasId)),
	])
	return { nodes, edges, comments }
}

async function checkpoint(
	canvasId: string,
	authorUserId: string,
	reason: string,
) {
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(eq(canvases.id, canvasId))
		.limit(1)
	if (!canvas) throw new Error("Canvas not found")
	const state = await snapshot(canvasId)
	const [updated] = await db
		.update(canvases)
		.set({
			revision: sql`${canvases.revision} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(canvases.id, canvasId))
		.returning({ revision: canvases.revision })
	if (!updated) throw new Error("Canvas checkpoint failed")
	await db.insert(canvasRevisions).values({
		canvasId,
		revision: updated.revision,
		authorUserId,
		reason,
		snapshot: state,
	})
}

async function workspace(canvasId: string) {
	const [nodes, edges, comments] = await Promise.all([
		db
			.select({
				id: canvasNodes.id,
				kind: canvasNodes.kind,
				label: canvasNodes.label,
				x: canvasNodes.x,
				y: canvasNodes.y,
				width: canvasNodes.width,
				height: canvasNodes.height,
				zIndex: canvasNodes.zIndex,
				version: canvasNodes.version,
				data: canvasNodes.data,
				artifactId: canvasNodes.artifactId,
				documentId: canvasNodes.documentId,
				captureId: canvasNodes.captureId,
				designAssetId: canvasNodes.designAssetId,
				artifactTitle: ideas.title,
				artifactKind: ideas.kind,
				artifactBody: ideas.body,
				artifactCode: ideas.generatedCode,
				artifactSources: ideas.sourceRefs,
				documentTitle: documents.title,
				documentUrl: documents.url,
				documentSource: documents.source,
				captureTitle: captures.title,
				captureUrl: captures.url,
				captureScreenshot: captures.screenshot,
				designAssetName: designAssets.name,
				designAssetKind: designAssets.kind,
				designAssetDescription: designAssets.description,
			})
			.from(canvasNodes)
			.leftJoin(ideas, eq(ideas.id, canvasNodes.artifactId))
			.leftJoin(documents, eq(documents.id, canvasNodes.documentId))
			.leftJoin(captures, eq(captures.id, canvasNodes.captureId))
			.leftJoin(designAssets, eq(designAssets.id, canvasNodes.designAssetId))
			.where(eq(canvasNodes.canvasId, canvasId))
			.orderBy(asc(canvasNodes.zIndex), asc(canvasNodes.createdAt)),
		db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvasId)),
		db
			.select()
			.from(canvasComments)
			.where(eq(canvasComments.canvasId, canvasId))
			.orderBy(asc(canvasComments.createdAt)),
	])
	return { nodes, edges, comments }
}

async function visibleArtifact(
	artifactId: string,
	caller: Awaited<ReturnType<typeof requireCaller>>,
) {
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, artifactId))
		.limit(1)
	if (!artifact) return null
	const project = await getVisibleProject(artifact.projectId, caller)
	return project ? { artifact, project } : null
}

canvasRoute.get("/projects/:projectId/canvas", async (c) => {
	const caller = await requireCaller(c)
	const project = await getVisibleProject(c.req.param("projectId"), caller)
	if (!project) return c.json({ error: "Project not found" }, 404)
	const canvas = await canvasForProject(project.id)
	return c.json({ project, canvas, ...(await workspace(canvas.id)) })
})

canvasRoute.get("/artifacts/:id/revisions", async (c) => {
	const caller = await requireCaller(c)
	const visible = await visibleArtifact(c.req.param("id"), caller)
	if (!visible) return c.json({ error: "Artifact not found" }, 404)
	const revisions = await db
		.select()
		.from(artifactRevisions)
		.where(eq(artifactRevisions.artifactId, visible.artifact.id))
		.orderBy(desc(artifactRevisions.version))
	return c.json({ artifact: visible.artifact, revisions })
})

const artifactEditSchema = z
	.object({
		title: z.string().trim().min(1).max(240).optional(),
		body: z.string().max(100_000).nullable().optional(),
	})
	.refine((value) => value.title !== undefined || value.body !== undefined, {
		message: "Provide a title or body",
	})

canvasRoute.patch(
	"/artifacts/:id",
	zValidator("json", artifactEditSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleArtifact(c.req.param("id"), caller)
		if (!visible) return c.json({ error: "Artifact not found" }, 404)
		const input = c.req.valid("json")
		const result = await db.transaction(async (tx) => {
			const [latest] = await tx
				.select({ version: artifactRevisions.version })
				.from(artifactRevisions)
				.where(eq(artifactRevisions.artifactId, visible.artifact.id))
				.orderBy(desc(artifactRevisions.version))
				.limit(1)
			const [artifact] = await tx
				.update(ideas)
				.set({ ...input, updatedAt: new Date() })
				.where(eq(ideas.id, visible.artifact.id))
				.returning()
			if (!artifact) throw new Error("Artifact update failed")
			const [revision] = await tx
				.insert(artifactRevisions)
				.values({
					artifactId: artifact.id,
					version: (latest?.version ?? 0) + 1,
					authorUserId: caller.userId,
					title: artifact.title,
					content: {
						body: artifact.body,
						generatedCode: artifact.generatedCode,
					},
					sourceRefs: artifact.sourceRefs ?? [],
				})
				.returning()
			return { artifact, revision }
		})
		return c.json(result)
	},
)

const artifactBranchSchema = z.object({ revisionId: z.string().optional() })

canvasRoute.post(
	"/artifacts/:id/branch",
	zValidator("json", artifactBranchSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleArtifact(c.req.param("id"), caller)
		if (!visible) return c.json({ error: "Artifact not found" }, 404)
		const { revisionId } = c.req.valid("json")
		const [source] = await db
			.select()
			.from(artifactRevisions)
			.where(
				revisionId
					? and(
							eq(artifactRevisions.artifactId, visible.artifact.id),
							eq(artifactRevisions.id, revisionId),
						)
					: eq(artifactRevisions.artifactId, visible.artifact.id),
			)
			.orderBy(desc(artifactRevisions.version))
			.limit(1)
		if (!source) return c.json({ error: "Artifact revision not found" }, 404)
		const [sourceNode] = await db
			.select()
			.from(canvasNodes)
			.where(eq(canvasNodes.artifactId, visible.artifact.id))
			.orderBy(asc(canvasNodes.createdAt))
			.limit(1)
		if (!sourceNode)
			return c.json({ error: "Artifact is not on a canvas" }, 409)
		const content = source.content as {
			body?: string | null
			generatedCode?: string | null
		}
		await checkpoint(sourceNode.canvasId, caller.userId, "branch artifact")
		const result = await db.transaction(async (tx) => {
			const [artifact] = await tx
				.insert(ideas)
				.values({
					projectId: visible.project.id,
					authorUserId: caller.userId,
					kind: visible.artifact.kind,
					title: `${source.title} branch`.slice(0, 240),
					body: content.body ?? null,
					generatedCode: content.generatedCode ?? null,
					prompt: visible.artifact.prompt,
					sourceRefs: visible.artifact.sourceRefs,
				})
				.returning()
			if (!artifact) throw new Error("Artifact branch creation failed")
			await tx.insert(artifactRevisions).values({
				artifactId: artifact.id,
				version: 1,
				authorUserId: caller.userId,
				title: artifact.title,
				content: { body: artifact.body, generatedCode: artifact.generatedCode },
				sourceRefs: artifact.sourceRefs ?? [],
				parentRevisionId: source.id,
			})
			const [node] = await tx
				.insert(canvasNodes)
				.values({
					canvasId: sourceNode.canvasId,
					kind: "artifact",
					artifactId: artifact.id,
					label: artifact.title,
					x: sourceNode.x + 48,
					y: sourceNode.y + 48,
					width: sourceNode.width,
					height: sourceNode.height,
					data: {
						artifactKind: artifact.kind,
						branchedFromRevisionId: source.id,
					},
				})
				.returning()
			return { artifact, node }
		})
		return c.json(result, 201)
	},
)

canvasRoute.get("/shared/:token", async (c) => {
	const [shareLink] = await db
		.select({ projectId: projectShareLinks.projectId })
		.from(projectShareLinks)
		.where(
			and(
				eq(projectShareLinks.tokenHash, tokenHash(c.req.param("token"))),
				isNull(projectShareLinks.revokedAt),
				gt(projectShareLinks.expiresAt, new Date()),
			),
		)
		.limit(1)
	if (!shareLink)
		return c.json({ error: "Share link is invalid or expired" }, 404)
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(eq(canvases.projectId, shareLink.projectId))
		.orderBy(asc(canvases.createdAt))
		.limit(1)
	if (!canvas) return c.json({ error: "Canvas not found" }, 404)
	const [project] = await db
		.select({ id: projects.id, name: projects.name })
		.from(projects)
		.where(eq(projects.id, shareLink.projectId))
		.limit(1)
	if (!project) return c.json({ error: "Project not found" }, 404)
	return c.json({
		project: { ...project, pinnedDesignSystemVersionId: null },
		canvas,
		...(await workspace(canvas.id)),
	})
})

canvasRoute.post(
	"/projects/:projectId/canvases",
	zValidator("json", z.object({ name: z.string().trim().min(1).max(120) })),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await getVisibleProject(c.req.param("projectId"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		const [canvas] = await db
			.insert(canvases)
			.values({ projectId: project.id, name: c.req.valid("json").name })
			.returning()
		return c.json({ canvas }, 201)
	},
)

const nodeSchema = z.object({
	kind: z.enum(["note", "frame"]),
	label: z.string().trim().min(1).max(240),
	x: z.number().int(),
	y: z.number().int(),
	width: z.number().int().min(160).max(2_000).default(320),
	height: z.number().int().min(80).max(2_000).default(220),
	data: z.record(z.unknown()).default({}),
})

canvasRoute.post(
	"/canvases/:id/nodes",
	zValidator("json", nodeSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleCanvas(
			c.req.param("id"),
			caller.userId,
			caller.orgId,
			caller.teamIds,
		)
		if (!visible) return c.json({ error: "Canvas not found" }, 404)
		const input = c.req.valid("json")
		const [node] = await db
			.insert(canvasNodes)
			.values({ canvasId: visible.canvas.id, ...input })
			.returning()
		await db
			.update(canvases)
			.set({
				revision: sql`${canvases.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(canvases.id, visible.canvas.id))
		return c.json({ node }, 201)
	},
)

const layoutSchema = z.object({
	nodes: z
		.array(
			z.object({
				id: z.string(),
				version: z.number().int().positive(),
				x: z.number().int(),
				y: z.number().int(),
				width: z.number().int().min(160).max(2_000),
				height: z.number().int().min(80).max(2_000),
			}),
		)
		.min(1)
		.max(100),
})

canvasRoute.patch(
	"/canvases/:id/layout",
	zValidator("json", layoutSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleCanvas(
			c.req.param("id"),
			caller.userId,
			caller.orgId,
			caller.teamIds,
		)
		if (!visible) return c.json({ error: "Canvas not found" }, 404)
		const input = c.req.valid("json")
		const result = await db.transaction(async (tx) => {
			const updated = []
			for (const node of input.nodes) {
				const [row] = await tx
					.update(canvasNodes)
					.set({
						x: node.x,
						y: node.y,
						width: node.width,
						height: node.height,
						version: node.version + 1,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(canvasNodes.id, node.id),
							eq(canvasNodes.canvasId, visible.canvas.id),
							eq(canvasNodes.version, node.version),
						),
					)
					.returning()
				if (!row) return null
				updated.push(row)
			}
			await tx
				.update(canvases)
				.set({
					revision: sql`${canvases.revision} + 1`,
					updatedAt: new Date(),
				})
				.where(eq(canvases.id, visible.canvas.id))
			return updated
		})
		if (!result)
			return c.json({ error: "Canvas changed. Refresh and try again." }, 409)
		return c.json({ nodes: result })
	},
)

const edgeSchema = z.object({
	sourceNodeId: z.string(),
	targetNodeId: z.string(),
	kind: edgeKindSchema.default("references"),
	label: z.string().trim().max(160).optional(),
})

canvasRoute.post(
	"/canvases/:id/edges",
	zValidator("json", edgeSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleCanvas(
			c.req.param("id"),
			caller.userId,
			caller.orgId,
			caller.teamIds,
		)
		if (!visible) return c.json({ error: "Canvas not found" }, 404)
		const input = c.req.valid("json")
		if (input.sourceNodeId === input.targetNodeId) {
			return c.json({ error: "A node cannot connect to itself" }, 400)
		}
		const nodes = await db
			.select({ id: canvasNodes.id })
			.from(canvasNodes)
			.where(
				and(
					eq(canvasNodes.canvasId, visible.canvas.id),
					inArray(canvasNodes.id, [input.sourceNodeId, input.targetNodeId]),
				),
			)
		if (nodes.length !== 2)
			return c.json({ error: "Invalid canvas nodes" }, 400)
		const [edge] = await db
			.insert(canvasEdges)
			.values({ canvasId: visible.canvas.id, ...input })
			.returning()
		await db
			.update(canvases)
			.set({
				revision: sql`${canvases.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(canvases.id, visible.canvas.id))
		return c.json({ edge }, 201)
	},
)

const positionedNodeSchema = z.object({
	x: z.number().int().default(160),
	y: z.number().int().default(160),
})

canvasRoute.post(
	"/projects/:projectId/documents/:documentId/nodes",
	zValidator("json", positionedNodeSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await getVisibleProject(c.req.param("projectId"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		const [document] = await db
			.select()
			.from(documents)
			.where(
				and(
					eq(documents.id, c.req.param("documentId")),
					eq(documents.orgId, caller.orgId),
					documentVisibility(caller),
				),
			)
			.limit(1)
		if (!document) return c.json({ error: "Document not found" }, 404)
		const canvas = await canvasForProject(project.id)
		const [existing] = await db
			.select()
			.from(canvasNodes)
			.where(
				and(
					eq(canvasNodes.canvasId, canvas.id),
					eq(canvasNodes.documentId, document.id),
				),
			)
			.limit(1)
		if (existing) return c.json({ node: existing })
		await checkpoint(canvas.id, caller.userId, "add knowledge context")
		const { x, y } = c.req.valid("json")
		const [node] = await db
			.insert(canvasNodes)
			.values({
				canvasId: canvas.id,
				kind: "knowledge",
				documentId: document.id,
				label: document.title,
				x,
				y,
				width: 340,
				height: 240,
				data: { url: document.url, source: document.source },
			})
			.returning()
		return c.json({ node }, 201)
	},
)

canvasRoute.post(
	"/projects/:projectId/design-assets/:assetId/nodes",
	zValidator("json", positionedNodeSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await getVisibleProject(c.req.param("projectId"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		if (!project.pinnedDesignSystemVersionId) {
			return c.json({ error: "Project has no pinned design system" }, 409)
		}
		const [asset] = await db
			.select()
			.from(designAssets)
			.where(
				and(
					eq(designAssets.id, c.req.param("assetId")),
					eq(designAssets.versionId, project.pinnedDesignSystemVersionId),
				),
			)
			.limit(1)
		if (!asset) return c.json({ error: "Design asset not found" }, 404)
		const canvas = await canvasForProject(project.id)
		const [existing] = await db
			.select()
			.from(canvasNodes)
			.where(
				and(
					eq(canvasNodes.canvasId, canvas.id),
					eq(canvasNodes.designAssetId, asset.id),
				),
			)
			.limit(1)
		if (existing) return c.json({ node: existing })
		await checkpoint(canvas.id, caller.userId, "add design context")
		const { x, y } = c.req.valid("json")
		const [node] = await db
			.insert(canvasNodes)
			.values({
				canvasId: canvas.id,
				kind: "design_asset",
				designAssetId: asset.id,
				label: asset.name,
				x,
				y,
				width: 300,
				height: 200,
				data: asset.data,
			})
			.returning()
		return c.json({ node }, 201)
	},
)

canvasRoute.delete("/canvases/:canvasId/nodes/:nodeId", async (c) => {
	const caller = await requireCaller(c)
	const visible = await visibleCanvas(
		c.req.param("canvasId"),
		caller.userId,
		caller.orgId,
		caller.teamIds,
	)
	if (!visible) return c.json({ error: "Canvas not found" }, 404)
	await checkpoint(visible.canvas.id, caller.userId, "delete node")
	const [node] = await db
		.delete(canvasNodes)
		.where(
			and(
				eq(canvasNodes.id, c.req.param("nodeId")),
				eq(canvasNodes.canvasId, visible.canvas.id),
			),
		)
		.returning()
	if (!node) return c.json({ error: "Node not found" }, 404)
	return c.json({ node })
})

canvasRoute.delete("/canvases/:canvasId/edges/:edgeId", async (c) => {
	const caller = await requireCaller(c)
	const visible = await visibleCanvas(
		c.req.param("canvasId"),
		caller.userId,
		caller.orgId,
		caller.teamIds,
	)
	if (!visible) return c.json({ error: "Canvas not found" }, 404)
	const [edge] = await db
		.delete(canvasEdges)
		.where(
			and(
				eq(canvasEdges.id, c.req.param("edgeId")),
				eq(canvasEdges.canvasId, visible.canvas.id),
			),
		)
		.returning()
	if (!edge) return c.json({ error: "Edge not found" }, 404)
	await db
		.update(canvases)
		.set({
			revision: sql`${canvases.revision} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(canvases.id, visible.canvas.id))
	return c.json({ edge })
})

canvasRoute.post(
	"/canvases/:id/comments",
	zValidator(
		"json",
		z.object({
			nodeId: z.string().optional(),
			body: z.string().trim().min(1).max(4_000),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleCanvas(
			c.req.param("id"),
			caller.userId,
			caller.orgId,
			caller.teamIds,
		)
		if (!visible) return c.json({ error: "Canvas not found" }, 404)
		const input = c.req.valid("json")
		if (input.nodeId) {
			const [node] = await db
				.select({ id: canvasNodes.id })
				.from(canvasNodes)
				.where(
					and(
						eq(canvasNodes.id, input.nodeId),
						eq(canvasNodes.canvasId, visible.canvas.id),
					),
				)
			if (!node) return c.json({ error: "Node not found" }, 404)
		}
		const [comment] = await db
			.insert(canvasComments)
			.values({
				canvasId: visible.canvas.id,
				authorUserId: caller.userId,
				...input,
			})
			.returning()
		return c.json({ comment }, 201)
	},
)

canvasRoute.get("/canvases/:id/history", async (c) => {
	const caller = await requireCaller(c)
	const visible = await visibleCanvas(
		c.req.param("id"),
		caller.userId,
		caller.orgId,
		caller.teamIds,
	)
	if (!visible) return c.json({ error: "Canvas not found" }, 404)
	const revisions = await db
		.select()
		.from(canvasRevisions)
		.where(eq(canvasRevisions.canvasId, visible.canvas.id))
		.orderBy(desc(canvasRevisions.createdAt))
		.limit(50)
	return c.json({ revisions })
})

canvasRoute.post("/canvases/:id/revisions/:revisionId/restore", async (c) => {
	const caller = await requireCaller(c)
	const visible = await visibleCanvas(
		c.req.param("id"),
		caller.userId,
		caller.orgId,
		caller.teamIds,
	)
	if (!visible) return c.json({ error: "Canvas not found" }, 404)
	const [revision] = await db
		.select()
		.from(canvasRevisions)
		.where(
			and(
				eq(canvasRevisions.id, c.req.param("revisionId")),
				eq(canvasRevisions.canvasId, visible.canvas.id),
			),
		)
		.limit(1)
	if (!revision) return c.json({ error: "Checkpoint not found" }, 404)
	const parsed = canvasSnapshotSchema.safeParse(revision.snapshot)
	if (!parsed.success) {
		return c.json(
			{ error: "This older checkpoint cannot be restored safely." },
			409,
		)
	}
	const state = parsed.data
	if (
		[...state.nodes, ...state.edges, ...state.comments].some(
			(item) => item.canvasId !== visible.canvas.id,
		)
	) {
		return c.json({ error: "Checkpoint belongs to another canvas" }, 409)
	}
	await checkpoint(
		visible.canvas.id,
		caller.userId,
		`before restore: ${revision.reason}`,
	)
	await db.transaction(async (tx) => {
		await tx
			.delete(canvasEdges)
			.where(eq(canvasEdges.canvasId, visible.canvas.id))
		await tx
			.delete(canvasComments)
			.where(eq(canvasComments.canvasId, visible.canvas.id))
		await tx
			.delete(canvasNodes)
			.where(eq(canvasNodes.canvasId, visible.canvas.id))
		if (state.nodes.length) await tx.insert(canvasNodes).values(state.nodes)
		if (state.edges.length) await tx.insert(canvasEdges).values(state.edges)
		if (state.comments.length)
			await tx.insert(canvasComments).values(state.comments)
		await tx
			.update(canvases)
			.set({
				revision: sql`${canvases.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(canvases.id, visible.canvas.id))
	})
	const [canvas] = await db
		.select()
		.from(canvases)
		.where(eq(canvases.id, visible.canvas.id))
		.limit(1)
	return c.json({
		project: visible.project,
		canvas,
		...(await workspace(visible.canvas.id)),
	})
})

canvasRoute.post(
	"/canvases/:id/checkpoint",
	zValidator("json", z.object({ reason: z.string().trim().min(1).max(160) })),
	async (c) => {
		const caller = await requireCaller(c)
		const visible = await visibleCanvas(
			c.req.param("id"),
			caller.userId,
			caller.orgId,
			caller.teamIds,
		)
		if (!visible) return c.json({ error: "Canvas not found" }, 404)
		await checkpoint(
			visible.canvas.id,
			caller.userId,
			c.req.valid("json").reason,
		)
		return c.json({ ok: true })
	},
)

const captureSchema = z.object({
	title: z.string().trim().min(1).max(240),
	url: z.string().url(),
	domOutline: z.string().min(1).max(500_000),
	screenshot: z.string().startsWith("data:image/").max(10_000_000).optional(),
	metadata: z.record(z.unknown()).default({}),
	x: z.number().int().default(0),
	y: z.number().int().default(0),
	previousCaptureId: z.string().optional(),
})

function tokenHash(token: string) {
	return createHash("sha256").update(token).digest("hex")
}

canvasRoute.post("/projects/:projectId/capture-tokens", async (c) => {
	const caller = await requireCaller(c)
	const project = await getVisibleProject(c.req.param("projectId"), caller)
	if (!project) return c.json({ error: "Project not found" }, 404)
	const token = randomBytes(32).toString("base64url")
	const [created] = await db
		.insert(captureTokens)
		.values({
			projectId: project.id,
			createdBy: caller.userId,
			tokenHash: tokenHash(token),
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
		})
		.returning({ expiresAt: captureTokens.expiresAt })
	return c.json({ token, expiresAt: created?.expiresAt }, 201)
})

canvasRoute.post(
	"/projects/:projectId/captures",
	zValidator("json", captureSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await getVisibleProject(c.req.param("projectId"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		const input = c.req.valid("json")
		const canvas = await canvasForProject(project.id)
		await checkpoint(canvas.id, caller.userId, "add product capture")
		const { previousCaptureId, x, y, ...captureInput } = input
		const result = await db.transaction(async (tx) => {
			const [capture] = await tx
				.insert(captures)
				.values({
					projectId: project.id,
					authorUserId: caller.userId,
					...captureInput,
				})
				.returning()
			if (!capture) throw new Error("Capture creation returned no row")
			const [node] = await tx
				.insert(canvasNodes)
				.values({
					canvasId: canvas.id,
					kind: "capture",
					captureId: capture.id,
					label: capture.title,
					x,
					y,
					width: 360,
					height: 300,
					data: { url: capture.url },
				})
				.returning()
			if (previousCaptureId) {
				const [previous] = await tx
					.select({ id: canvasNodes.id })
					.from(canvasNodes)
					.where(
						and(
							eq(canvasNodes.canvasId, canvas.id),
							eq(canvasNodes.captureId, previousCaptureId),
						),
					)
				if (previous && node) {
					await tx.insert(canvasEdges).values({
						canvasId: canvas.id,
						sourceNodeId: previous.id,
						targetNodeId: node.id,
						kind: "flows_to",
					})
				}
			}
			return { capture, node }
		})
		return c.json(result, 201)
	},
)

const generateSchema = z.object({
	prompt: z.string().trim().min(1).max(8_000),
	kind: z
		.enum([
			"brief",
			"requirement",
			"user_flow",
			"state_matrix",
			"ux_review",
			"interface_spec",
			"test_case",
			"react_prototype",
		])
		.default("brief"),
	selectedNodeIds: z.array(z.string()).max(30).default([]),
})

const structuredArtifactSchema = z.object({
	title: z.string(),
	summary: z.string(),
	sections: z.array(
		z.object({ heading: z.string(), items: z.array(z.string()) }),
	),
})

canvasRoute.post(
	"/projects/:projectId/generate",
	zValidator("json", generateSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await getVisibleProject(c.req.param("projectId"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		const input = c.req.valid("json")
		const canvas = await canvasForProject(project.id)
		const selected = input.selectedNodeIds.length
			? await db
					.select({
						id: canvasNodes.id,
						label: canvasNodes.label,
						data: canvasNodes.data,
						artifactBody: ideas.body,
						artifactTitle: ideas.title,
						captureOutline: captures.domOutline,
						documentContent: documents.rawContent,
					})
					.from(canvasNodes)
					.leftJoin(ideas, eq(ideas.id, canvasNodes.artifactId))
					.leftJoin(captures, eq(captures.id, canvasNodes.captureId))
					.leftJoin(documents, eq(documents.id, canvasNodes.documentId))
					.where(
						and(
							eq(canvasNodes.canvasId, canvas.id),
							inArray(canvasNodes.id, input.selectedNodeIds),
						),
					)
			: []
		if (selected.length !== input.selectedNodeIds.length) {
			return c.json(
				{ error: "One or more selected nodes are unavailable" },
				400,
			)
		}
		const grounding = await searchMemories({
			q: input.prompt,
			...caller,
			limit: 8,
		})
		const selectedContext = selected
			.map((node) =>
				[
					node.label,
					node.artifactTitle,
					node.artifactBody,
					node.captureOutline,
					node.documentContent,
				]
					.filter(Boolean)
					.join("\n"),
			)
			.join("\n\n")
		const knowledge = grounding
			.map(
				(source, index) =>
					`[${index + 1}] ${source.title}\n${source.chunkContent}`,
			)
			.join("\n\n")
		let title: string
		let body: string | null
		let generatedCode: string | null = null
		if (input.kind === "react_prototype") {
			title = input.prompt.slice(0, 80)
			body = "React prototype grounded in selected product context."
			generatedCode = await generateUi(
				`${input.prompt}\n\nSelected canvas context:\n${selectedContext}`,
				grounding,
			)
		} else {
			const { object } = await withModelFallback((model) =>
				generateObject({
					model: openrouter.chat(model),
					schema: structuredArtifactSchema,
					system:
						"You are a product design collaborator. Produce a practical, evidence-grounded artifact. Always address missing requirements, permissions, loading, empty, error, validation, retry, quota, and recovery states where relevant.",
					prompt: `Artifact type: ${input.kind}\n\nCanvas context:\n${selectedContext || "(none selected)"}\n\nKnowledge:\n${knowledge || "(no matching knowledge)"}\n\nRequest: ${input.prompt}`,
				}),
			)
			title = object.title
			body = `${object.summary}\n\n${object.sections.map((section) => `## ${section.heading}\n${section.items.map((item) => `- ${item}`).join("\n")}`).join("\n\n")}`
		}
		await checkpoint(canvas.id, caller.userId, `generate ${input.kind}`)
		const artifact = await db.transaction(async (tx) => {
			const [idea] = await tx
				.insert(ideas)
				.values({
					projectId: project.id,
					authorUserId: caller.userId,
					kind:
						input.kind === "react_prototype" ? "react_prototype" : input.kind,
					title,
					body,
					generatedCode,
					prompt: input.prompt,
					sourceRefs: grounding.map((source) => ({
						documentId: source.documentId,
						title: source.title,
						url: source.url,
					})),
				})
				.returning()
			if (!idea) throw new Error("Artifact creation returned no row")
			await tx.insert(artifactRevisions).values({
				artifactId: idea.id,
				version: 1,
				authorUserId: caller.userId,
				title: idea.title,
				content: { body: idea.body, generatedCode: idea.generatedCode },
				generationInput: {
					prompt: input.prompt,
					selectedNodeIds: input.selectedNodeIds,
				},
				sourceRefs: idea.sourceRefs ?? [],
			})
			const [node] = await tx
				.insert(canvasNodes)
				.values({
					canvasId: canvas.id,
					kind: "artifact",
					artifactId: idea.id,
					label: idea.title,
					x: 420,
					y: 120 + input.selectedNodeIds.length * 36,
					width: input.kind === "react_prototype" ? 520 : 380,
					height: input.kind === "react_prototype" ? 460 : 280,
					data: { artifactKind: input.kind },
				})
				.returning()
			return { idea, node }
		})
		return c.json({ artifact })
	},
)
