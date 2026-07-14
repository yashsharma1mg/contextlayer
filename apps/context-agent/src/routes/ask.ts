import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import { answerFromContext } from "../lib/chat"
import { requireCaller } from "../lib/caller"
import { searchMemories } from "../lib/search"

export const askRoute = new Hono()

const askSchema = z.object({
	q: z.string().trim().min(1).max(8_000),
	limit: z.coerce.number().int().min(1).max(20).default(8),
})

askRoute.post("/", zValidator("json", askSchema), async (c) => {
	const caller = await requireCaller(c)
	const { q, limit } = c.req.valid("json")
	const sources = await searchMemories({ q, limit, ...caller })
	const answer = await answerFromContext(q, sources)
	return c.json({ answer, sources })
})
