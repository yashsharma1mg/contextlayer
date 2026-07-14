import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { z } from "zod"
import { extractText } from "../lib/extract-text"
import { ingestDocument } from "../lib/ingest"
import { searchMemories } from "../lib/search"

export const memoriesRoute = new Hono()

const scopeSchema = z.enum(["org", "team", "personal"])

// Shared correctness rule between the JSON route and the upload route —
// factored out rather than duplicated so a fix to one can't drift from the other.
const scopeRefinement = {
	check: (v: { scope: string; teamId?: string; ownerUserId?: string }) =>
		(v.scope === "team" && !!v.teamId) ||
		(v.scope === "personal" && !!v.ownerUserId) ||
		v.scope === "org",
	message: "teamId required for team scope, ownerUserId for personal scope",
}

const addDocumentSchema = z
	.object({
		orgId: z.string(),
		teamId: z.string().optional(),
		ownerUserId: z.string().optional(),
		scope: scopeSchema,
		source: z.enum(["confluence", "figma", "manual"]),
		sourceId: z.string(),
		title: z.string(),
		url: z.string().url().optional(),
		rawContent: z.string(),
		sourceUpdatedAt: z.string().datetime().optional(),
	})
	.refine(scopeRefinement.check, { message: scopeRefinement.message })

/** Ingest (or re-ingest) a document: chunk, embed, upsert by (source, sourceId). */
memoriesRoute.post("/", zValidator("json", addDocumentSchema), async (c) => {
	const body = c.req.valid("json")
	const result = await ingestDocument({
		...body,
		sourceUpdatedAt: body.sourceUpdatedAt
			? new Date(body.sourceUpdatedAt)
			: undefined,
	})
	return c.json(result)
})

const uploadFieldsSchema = z
	.object({
		orgId: z.string(),
		teamId: z.string().optional(),
		ownerUserId: z.string().optional(),
		scope: scopeSchema,
		title: z.string().optional(),
	})
	.refine(scopeRefinement.check, { message: scopeRefinement.message })

/**
 * Generic upload — not tied to any connector. Any file a user sends becomes
 * a document through the same ingest/understand/embed pipeline as
 * Confluence and Figma content.
 */
memoriesRoute.post("/upload", async (c) => {
	const body = await c.req.parseBody()
	const file = body.file
	if (!(file instanceof File)) throw new Error("Missing 'file' in form data")

	const fields = uploadFieldsSchema.parse({
		orgId: body.orgId,
		teamId: body.teamId || undefined,
		ownerUserId: body.ownerUserId || undefined,
		scope: body.scope,
		title: body.title || undefined,
	})

	const rawContent = await extractText(file)
	const result = await ingestDocument({
		...fields,
		source: "manual",
		sourceId: `upload:${nanoid()}`,
		title: fields.title ?? file.name,
		rawContent,
	})
	return c.json(result)
})

const searchSchema = z.object({
	q: z.string().min(1),
	orgId: z.string(),
	teamIds: z.array(z.string()).default([]),
	userId: z.string(),
	limit: z.coerce.number().int().min(1).max(50).default(10),
})

memoriesRoute.get("/search", zValidator("query", searchSchema), async (c) => {
	const results = await searchMemories(c.req.valid("query"))
	return c.json({ results })
})
