import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import { answerFromContext } from "../lib/chat"
import { searchMemories } from "../lib/search"

export const askRoute = new Hono()

const askSchema = z.object({
	q: z.string().min(1),
	orgId: z.string(),
	teamIds: z.array(z.string()).default([]),
	userId: z.string(),
	limit: z.coerce.number().int().min(1).max(20).default(8),
})

/** RAG Q&A: scope-aware search, then synthesize an answer with sources over the results. */
askRoute.post("/", zValidator("json", askSchema), async (c) => {
	const { q, ...scope } = c.req.valid("json")
	const sources = await searchMemories({ q, ...scope })
	const answer = await answerFromContext(q, sources)
	return c.json({ answer, sources })
})
