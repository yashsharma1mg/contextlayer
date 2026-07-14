import { zValidator } from "@hono/zod-validator"
import {
	canvases,
	db,
	ideaComments,
	ideas,
	projectShareLinks,
	projects,
} from "@repo/db"
import { generateObject } from "ai"
import { and, desc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import { requireCaller } from "../lib/caller"
import { generateUi } from "../lib/generate-ui"
import { openrouter, withModelFallback } from "../lib/openrouter"
import { getVisibleProject, projectVisibility } from "../lib/project-access"
import { type SearchResult, searchMemories } from "../lib/search"

export const ideasRoute = new Hono()

ideasRoute.post(
	"/projects",
	zValidator("json", z.object({ name: z.string().trim().min(1).max(120) })),
	async (c) => {
		const caller = await requireCaller(c)
		const { name } = c.req.valid("json")
		const result = await db.transaction(async (tx) => {
			const [project] = await tx
				.insert(projects)
				.values({ name, orgId: caller.orgId, ownerUserId: caller.userId })
				.returning()
			if (!project) throw new Error("Project creation returned no row")
			const [canvas] = await tx
				.insert(canvases)
				.values({ projectId: project.id, name: "Workspace" })
				.returning()
			return { project, canvas }
		})
		return c.json(result, 201)
	},
)

ideasRoute.get("/projects", async (c) => {
	const caller = await requireCaller(c)
	const rows = await db
		.select()
		.from(projects)
		.where(projectVisibility(caller))
		.orderBy(desc(projects.updatedAt))
	return c.json({ projects: rows })
})

ideasRoute.get("/projects/:id", async (c) => {
	const caller = await requireCaller(c)
	const project = await getVisibleProject(c.req.param("id"), caller)
	if (!project) return c.json({ error: "Project not found" }, 404)
	return c.json({ project })
})

const shareSchema = z
	.object({
		visibility: z.enum(["personal", "team", "org"]),
		teamId: z.string().optional(),
	})
	.refine((value) => value.visibility !== "team" || !!value.teamId, {
		message: "teamId required when sharing to a team",
	})

ideasRoute.patch(
	"/projects/:id/share",
	zValidator("json", shareSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const { visibility, teamId } = c.req.valid("json")
		if (teamId && !caller.teamIds.includes(teamId)) {
			return c.json({ error: "Team access denied" }, 403)
		}
		const [updated] = await db
			.update(projects)
			.set({
				visibility,
				teamId: visibility === "team" ? teamId : null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(projects.id, c.req.param("id")),
					eq(projects.orgId, caller.orgId),
					eq(projects.ownerUserId, caller.userId),
				),
			)
			.returning()
		if (!updated) return c.json({ error: "Not found or not the owner" }, 404)
		return c.json({ project: updated })
	},
)

const shareLinkSchema = z.object({
	expiresInDays: z.number().int().min(1).max(365).default(30),
})

function shareTokenHash(token: string) {
	return createHash("sha256").update(token).digest("hex")
}

async function ownerProject(projectId: string, userId: string, orgId: string) {
	const [project] = await db
		.select()
		.from(projects)
		.where(
			and(
				eq(projects.id, projectId),
				eq(projects.orgId, orgId),
				eq(projects.ownerUserId, userId),
			),
		)
		.limit(1)
	return project
}

ideasRoute.post(
	"/projects/:id/share-links",
	zValidator("json", shareLinkSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const project = await ownerProject(
			c.req.param("id"),
			caller.userId,
			caller.orgId,
		)
		if (!project) return c.json({ error: "Not found or not the owner" }, 404)
		const { expiresInDays } = c.req.valid("json")
		const token = `cls_${randomBytes(32).toString("base64url")}`
		const [shareLink] = await db
			.insert(projectShareLinks)
			.values({
				projectId: project.id,
				createdBy: caller.userId,
				tokenHash: shareTokenHash(token),
				expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60_000),
			})
			.returning({
				id: projectShareLinks.id,
				expiresAt: projectShareLinks.expiresAt,
			})
		return c.json({ shareLink, token }, 201)
	},
)

ideasRoute.get("/projects/:id/share-links", async (c) => {
	const caller = await requireCaller(c)
	const project = await ownerProject(
		c.req.param("id"),
		caller.userId,
		caller.orgId,
	)
	if (!project) return c.json({ error: "Not found or not the owner" }, 404)
	const shareLinks = await db
		.select({
			id: projectShareLinks.id,
			expiresAt: projectShareLinks.expiresAt,
			revokedAt: projectShareLinks.revokedAt,
			createdAt: projectShareLinks.createdAt,
		})
		.from(projectShareLinks)
		.where(eq(projectShareLinks.projectId, project.id))
		.orderBy(desc(projectShareLinks.createdAt))
		.limit(20)
	return c.json({ shareLinks })
})

ideasRoute.delete("/projects/:projectId/share-links/:linkId", async (c) => {
	const caller = await requireCaller(c)
	const project = await ownerProject(
		c.req.param("projectId"),
		caller.userId,
		caller.orgId,
	)
	if (!project) return c.json({ error: "Not found or not the owner" }, 404)
	const [shareLink] = await db
		.update(projectShareLinks)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(projectShareLinks.id, c.req.param("linkId")),
				eq(projectShareLinks.projectId, project.id),
			),
		)
		.returning({ id: projectShareLinks.id })
	if (!shareLink) return c.json({ error: "Share link not found" }, 404)
	return c.json({ ok: true })
})

const generateSchema = z.object({
	projectId: z.string(),
	prompt: z.string().trim().min(1).max(8_000),
})

const toSourceRefs = (results: SearchResult[]) =>
	[
		...new Map(results.map((result) => [result.documentId, result])).values(),
	].map((result) => ({
		documentId: result.documentId,
		title: result.title,
		url: result.url,
	}))

const conceptSchema = z.object({
	title: z.string(),
	summary: z.string(),
	keyFlows: z.array(z.string()),
	edgeCases: z.array(z.string()),
	openQuestions: z.array(z.string()),
})

ideasRoute.post(
	"/ideas/concept",
	zValidator("json", generateSchema),
	async (c) => {
		const caller = await requireCaller(c)
		const body = c.req.valid("json")
		const project = await getVisibleProject(body.projectId, caller)
		if (!project) return c.json({ error: "Project not found" }, 404)

		const grounding = await searchMemories({
			q: body.prompt,
			...caller,
			limit: 8,
		})
		const context = grounding
			.map(
				(source, index) =>
					`[${index + 1}] ${source.title}\n${source.chunkContent}`,
			)
			.join("\n\n")

		const { object: concept } = await withModelFallback((model) =>
			generateObject({
				model: openrouter.chat(model),
				schema: conceptSchema,
				system:
					"You are a product design partner. Ground the concept in supplied evidence. Cover the primary flow plus empty, loading, error, validation, permission, quota, retry, and recovery states when relevant. Be concrete and call out missing decisions.",
				prompt: `Product context:\n${context || "(no matching knowledge found)"}\n\nRequest: ${body.prompt}`,
			}),
		)

		const [idea] = await db
			.insert(ideas)
			.values({
				projectId: project.id,
				authorUserId: caller.userId,
				kind: "concept",
				title: concept.title,
				body: `${concept.summary}\n\n**Key flows**\n${concept.keyFlows.map((flow) => `- ${flow}`).join("\n")}\n\n**Edge cases**\n${concept.edgeCases.map((item) => `- ${item}`).join("\n")}\n\n**Open questions**\n${concept.openQuestions.map((question) => `- ${question}`).join("\n")}`,
				prompt: body.prompt,
				sourceRefs: toSourceRefs(grounding),
			})
			.returning()
		return c.json({ idea })
	},
)

ideasRoute.post("/ideas/ui", zValidator("json", generateSchema), async (c) => {
	const caller = await requireCaller(c)
	const body = c.req.valid("json")
	const project = await getVisibleProject(body.projectId, caller)
	if (!project) return c.json({ error: "Project not found" }, 404)
	const grounding = await searchMemories({
		q: body.prompt,
		...caller,
		limit: 5,
	})
	const html = await generateUi(body.prompt, grounding)
	const [idea] = await db
		.insert(ideas)
		.values({
			projectId: project.id,
			authorUserId: caller.userId,
			kind: "ui",
			title: body.prompt.slice(0, 80),
			generatedCode: html,
			prompt: body.prompt,
			sourceRefs: toSourceRefs(grounding),
		})
		.returning()
	return c.json({ idea })
})

ideasRoute.get("/projects/:id/ideas", async (c) => {
	const caller = await requireCaller(c)
	const project = await getVisibleProject(c.req.param("id"), caller)
	if (!project) return c.json({ error: "Project not found" }, 404)
	const rows = await db
		.select()
		.from(ideas)
		.where(eq(ideas.projectId, project.id))
		.orderBy(desc(ideas.createdAt))
	return c.json({ ideas: rows })
})

ideasRoute.post(
	"/ideas/:id/comments",
	zValidator("json", z.object({ body: z.string().trim().min(1).max(4_000) })),
	async (c) => {
		const caller = await requireCaller(c)
		const [idea] = await db
			.select({ id: ideas.id, projectId: ideas.projectId })
			.from(ideas)
			.where(eq(ideas.id, c.req.param("id")))
		if (!idea || !(await getVisibleProject(idea.projectId, caller))) {
			return c.json({ error: "Idea not found" }, 404)
		}
		const [comment] = await db
			.insert(ideaComments)
			.values({
				ideaId: idea.id,
				authorUserId: caller.userId,
				body: c.req.valid("json").body,
			})
			.returning()
		return c.json({ comment })
	},
)

ideasRoute.get("/ideas/:id/comments", async (c) => {
	const caller = await requireCaller(c)
	const [idea] = await db
		.select({ id: ideas.id, projectId: ideas.projectId })
		.from(ideas)
		.where(eq(ideas.id, c.req.param("id")))
	if (!idea || !(await getVisibleProject(idea.projectId, caller))) {
		return c.json({ error: "Idea not found" }, 404)
	}
	const rows = await db
		.select()
		.from(ideaComments)
		.where(eq(ideaComments.ideaId, idea.id))
		.orderBy(ideaComments.createdAt)
	return c.json({ comments: rows })
})
