import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import { enqueueJob } from "../lib/background-jobs"
import { requireCaller } from "../lib/caller"
import { extractionCategory } from "../lib/extract-text"
import { ingestDocument } from "../lib/ingest"
import { storeObject } from "../lib/local-storage"
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
		createdBy: caller.userId,
		consentUserId: caller.userId,
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
	const category = extractionCategory(file)
	const limit =
		category === "image"
			? 20 * 1024 * 1024
			: category === "audio"
				? 100 * 1024 * 1024
				: 250 * 1024 * 1024
	if (file.size > limit)
		return c.json({ error: `${category} exceeds its upload limit` }, 413)

	const fields = uploadFieldsSchema.parse({
		teamId: body.teamId || undefined,
		scope: body.scope,
		title: body.title || undefined,
	})
	if (fields.teamId && !caller.teamIds.includes(fields.teamId)) {
		return c.json({ error: "Team access denied" }, 403)
	}

	const bytes = new Uint8Array(await file.arrayBuffer())
	const original = await storeObject({
		orgId: caller.orgId,
		kind: "source_original",
		data: bytes,
		mimeType: file.type || "application/octet-stream",
		metadata: { fileName: file.name },
	})
	const job = await enqueueJob({
		orgId: caller.orgId,
		createdBy: caller.userId,
		type: "ingest.object",
		payload: {
			orgId: caller.orgId,
			userId: caller.userId,
			objectId: original.id,
			fileName: file.name,
			mimeType: file.type || "application/octet-stream",
			title: fields.title ?? file.name,
			scope: fields.scope,
			...(fields.scope === "team" ? { teamId: fields.teamId } : {}),
		},
	})
	return c.json({ job }, 202)
})

memoriesRoute.post(
	"/url",
	zValidator(
		"json",
		scopedInput.and(
			z.object({
				url: z.string().url(),
				title: z.string().trim().min(1).max(240).optional(),
			}),
		),
	),
	async (c) => {
		const caller = await requireCaller(c)
		const input = c.req.valid("json")
		if (input.teamId && !caller.teamIds.includes(input.teamId)) {
			return c.json({ error: "Team access denied" }, 403)
		}
		const job = await enqueueJob({
			orgId: caller.orgId,
			createdBy: caller.userId,
			type: "ingest.url",
			payload: {
				orgId: caller.orgId,
				userId: caller.userId,
				url: input.url,
				title: input.title,
				scope: input.scope,
				...(input.scope === "team" ? { teamId: input.teamId } : {}),
			},
			idempotencyKey: `url:${input.url}:${input.scope}:${Math.floor(Date.now() / 60_000)}`,
		})
		return c.json({ job }, 202)
	},
)

const searchSchema = z.object({
	q: z.string().trim().min(1).max(8_000),
	limit: z.coerce.number().int().min(1).max(50).default(10),
})

memoriesRoute.get("/search", zValidator("query", searchSchema), async (c) => {
	const caller = await requireCaller(c)
	const results = await searchMemories({ ...c.req.valid("query"), ...caller })
	return c.json({ results })
})
