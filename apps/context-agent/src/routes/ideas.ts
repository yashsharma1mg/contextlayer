import { zValidator } from "@hono/zod-validator"
import { db, ideaComments, ideas, projects } from "@repo/db"
import { generateObject } from "ai"
import { and, desc, eq, or, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { generateUi } from "../lib/generate-ui"
import { openrouter, withModelFallback } from "../lib/openrouter"
import { type SearchResult, searchMemories } from "../lib/search"

export const ideasRoute = new Hono()

/**
 * Same trust model as the rest of the API for v1: orgId/userId/teamIds come
 * from the client. Session-derived identity is a known, flagged gap to fix
 * before any multi-tenant pilot — kept consistent here rather than fixed
 * piecemeal in one route.
 */
const callerSchema = z.object({
	orgId: z.string(),
	userId: z.string(),
	teamIds: z.array(z.string()).default([]),
})

/** Mirrors searchMemories()'s visibility clause, applied to projects. */
function projectVisibility(caller: z.infer<typeof callerSchema>) {
	return and(
		eq(projects.orgId, caller.orgId),
		or(
			eq(projects.visibility, "org"),
			caller.teamIds.length > 0
				? and(
						eq(projects.visibility, "team"),
						sql`${projects.teamId} = ANY(${caller.teamIds})`,
					)
				: undefined,
			and(
				eq(projects.visibility, "personal"),
				eq(projects.ownerUserId, caller.userId),
			),
		),
	)
}

async function getVisibleProject(
	projectId: string,
	caller: z.infer<typeof callerSchema>,
) {
	const [project] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.id, projectId), projectVisibility(caller)))
	return project ?? null
}

// --- Projects ---

ideasRoute.post(
	"/projects",
	zValidator("json", callerSchema.extend({ name: z.string().min(1) })),
	async (c) => {
		const { name, orgId, userId } = c.req.valid("json")
		const [project] = await db
			.insert(projects)
			.values({ name, orgId, ownerUserId: userId })
			.returning()
		return c.json({ project })
	},
)

ideasRoute.get("/projects", zValidator("query", callerSchema), async (c) => {
	const caller = c.req.valid("query")
	const rows = await db
		.select()
		.from(projects)
		.where(projectVisibility(caller))
		.orderBy(desc(projects.updatedAt))
	return c.json({ projects: rows })
})

const shareSchema = callerSchema
	.extend({
		visibility: z.enum(["personal", "team", "org"]),
		teamId: z.string().optional(),
	})
	.refine((v) => v.visibility !== "team" || !!v.teamId, {
		message: "teamId required when sharing to a team",
	})

/** Share (or unshare) a project. Only the owner can change visibility. */
ideasRoute.patch(
	"/projects/:id/share",
	zValidator("json", shareSchema),
	async (c) => {
		const { visibility, teamId, userId } = c.req.valid("json")
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
					eq(projects.ownerUserId, userId),
				),
			)
			.returning()
		if (!updated) return c.json({ error: "Not found or not the owner" }, 404)
		return c.json({ project: updated })
	},
)

// --- Ideas ---

const generateSchema = callerSchema.extend({
	projectId: z.string(),
	prompt: z.string().min(1),
})

const toSourceRefs = (results: SearchResult[]) =>
	[...new Map(results.map((r) => [r.documentId, r])).values()].map((r) => ({
		documentId: r.documentId,
		title: r.title,
		url: r.url,
	}))

const conceptSchema = z.object({
	title: z.string(),
	summary: z.string(),
	keyFlows: z.array(z.string()),
	openQuestions: z.array(z.string()),
})

ideasRoute.post(
	"/ideas/concept",
	zValidator("json", generateSchema),
	async (c) => {
		const body = c.req.valid("json")
		const project = await getVisibleProject(body.projectId, body)
		if (!project) return c.json({ error: "Project not found" }, 404)

		const grounding = await searchMemories({
			q: body.prompt,
			...body,
			limit: 8,
		})
		const context = grounding
			.map((s, i) => `[${i + 1}] ${s.title}\n${s.chunkContent}`)
			.join("\n\n")

		const { object: concept } = await withModelFallback((model) =>
			generateObject({
				model: openrouter.chat(model),
				schema: conceptSchema,
				system:
					"You are a product-ideation partner. Using the team context provided, turn the prompt into a concrete product concept: a sharp title, a summary grounded in what the team already knows, the key user flows, and the open questions the team still needs to answer. Stay specific to the context — no generic filler.",
				prompt: `Team context:\n${context || "(no relevant context found)"}\n\nIdea prompt: ${body.prompt}`,
			}),
		)

		const [idea] = await db
			.insert(ideas)
			.values({
				projectId: project.id,
				authorUserId: body.userId,
				kind: "concept",
				title: concept.title,
				body: `${concept.summary}\n\n**Key flows**\n${concept.keyFlows.map((f) => `- ${f}`).join("\n")}\n\n**Open questions**\n${concept.openQuestions.map((q) => `- ${q}`).join("\n")}`,
				prompt: body.prompt,
				sourceRefs: toSourceRefs(grounding),
			})
			.returning()
		return c.json({ idea })
	},
)

ideasRoute.post("/ideas/ui", zValidator("json", generateSchema), async (c) => {
	const body = c.req.valid("json")
	const project = await getVisibleProject(body.projectId, body)
	if (!project) return c.json({ error: "Project not found" }, 404)

	const grounding = await searchMemories({ q: body.prompt, ...body, limit: 5 })
	const html = await generateUi(body.prompt, grounding)

	const [idea] = await db
		.insert(ideas)
		.values({
			projectId: project.id,
			authorUserId: body.userId,
			kind: "ui",
			title: body.prompt.slice(0, 80),
			generatedCode: html,
			prompt: body.prompt,
			sourceRefs: toSourceRefs(grounding),
		})
		.returning()
	return c.json({ idea })
})

ideasRoute.get(
	"/projects/:id/ideas",
	zValidator("query", callerSchema),
	async (c) => {
		const caller = c.req.valid("query")
		const project = await getVisibleProject(c.req.param("id"), caller)
		if (!project) return c.json({ error: "Project not found" }, 404)
		const rows = await db
			.select()
			.from(ideas)
			.where(eq(ideas.projectId, project.id))
			.orderBy(desc(ideas.createdAt))
		return c.json({ ideas: rows })
	},
)

// --- Comments ---

ideasRoute.post(
	"/ideas/:id/comments",
	zValidator("json", callerSchema.extend({ body: z.string().min(1) })),
	async (c) => {
		const caller = c.req.valid("json")
		// Visibility check routes through the idea's project.
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
				body: caller.body,
			})
			.returning()
		return c.json({ comment })
	},
)

ideasRoute.get(
	"/ideas/:id/comments",
	zValidator("query", callerSchema),
	async (c) => {
		const caller = c.req.valid("query")
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
	},
)
