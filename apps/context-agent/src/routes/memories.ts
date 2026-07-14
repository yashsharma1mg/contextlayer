import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { nanoid } from "nanoid"
import { z } from "zod"
import { requireCaller } from "../lib/caller"
import { extractText } from "../lib/extract-text"
import { ingestDocument } from "../lib/ingest"
import { searchMemories } from "../lib/search"

export const memoriesRoute = new Hono()

const scopeSchema = z.enum(["org", "team", "personal"])
const sourceSchema = z.enum([
	"confluence",
	"figma",
	"manual",
	"url",
	"github",
	"notion",
	"google_drive",
	"slack",
	"capture",
])

const scopedInput = z
	.object({
		teamId: z.string().optional(),
		scope: scopeSchema,
	})
	.refine((value) => value.scope !== "team" || !!value.teamId, {
		message: "teamId required for team scope",
	})

const addDocumentSchema = scopedInput.and(
	z.object({
		source: sourceSchema,
		sourceId: z.string(),
		title: z.string(),
		url: z.string().url().optional(),
		rawContent: z.string(),
		mimeType: z.string().optional(),
		provenance: z.record(z.unknown()).optional(),
		sourceUpdatedAt: z.string().datetime().optional(),
	}),
)

memoriesRoute.post("/", zValidator("json", addDocumentSchema), async (c) => {
	const caller = await requireCaller(c)
	const body = c.req.valid("json")
	if (body.teamId && !caller.teamIds.includes(body.teamId)) {
		return c.json({ error: "Team access denied" }, 403)
	}
	const result = await ingestDocument({
		...body,
		orgId: caller.orgId,
		ownerUserId: body.scope === "personal" ? caller.userId : undefined,
		sourceUpdatedAt: body.sourceUpdatedAt
			? new Date(body.sourceUpdatedAt)
			: undefined,
	})
	return c.json(result)
})

const uploadFieldsSchema = scopedInput.and(
	z.object({ title: z.string().optional() }),
)

memoriesRoute.post("/upload", async (c) => {
	const caller = await requireCaller(c)
	const body = await c.req.parseBody()
	const file = body.file
	if (!(file instanceof File)) throw new Error("Missing 'file' in form data")

	const fields = uploadFieldsSchema.parse({
		teamId: body.teamId || undefined,
		scope: body.scope,
		title: body.title || undefined,
	})
	if (fields.teamId && !caller.teamIds.includes(fields.teamId)) {
		return c.json({ error: "Team access denied" }, 403)
	}

	const rawContent = await extractText(file)
	const result = await ingestDocument({
		...fields,
		orgId: caller.orgId,
		ownerUserId: fields.scope === "personal" ? caller.userId : undefined,
		source: "manual",
		sourceId: `upload:${nanoid()}`,
		title: fields.title ?? file.name,
		rawContent,
		mimeType: file.type || undefined,
		provenance: { fileName: file.name, size: file.size },
	})
	return c.json(result)
})

const searchSchema = z.object({
	q: z.string().trim().min(1).max(8_000),
	limit: z.coerce.number().int().min(1).max(50).default(10),
})

memoriesRoute.get("/search", zValidator("query", searchSchema), async (c) => {
	const caller = await requireCaller(c)
	const results = await searchMemories({ ...c.req.valid("query"), ...caller })
	return c.json({ results })
})
