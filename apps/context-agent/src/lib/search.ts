import { db, documents, memoryChunks } from "@repo/db"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { documentVisibility } from "./access-policy"
import { embedQuery } from "./embeddings"
import { hasProviderConsent } from "./provider-consent"

export interface SearchParams {
	q: string
	orgId: string
	teamIds: string[]
	userId: string
	limit: number
}

export interface SearchResult {
	chunkId: string
	documentId: string
	title: string
	url: string | null
	source:
		| "confluence"
		| "figma"
		| "manual"
		| "url"
		| "github"
		| "notion"
		| "google_drive"
		| "slack"
		| "capture"
	scope: "org" | "team" | "personal"
	chunkContent: string
	chunkProvenance: Record<string, unknown> | null
	distance: number
}

export function provenanceLabel(provenance: Record<string, unknown> | null) {
	if (!provenance) return ""
	if (typeof provenance.page === "number") return `page ${provenance.page}`
	if (typeof provenance.slide === "number") return `slide ${provenance.slide}`
	if (typeof provenance.sheetName === "string")
		return `sheet ${provenance.sheetName}`
	if (typeof provenance.timestampSeconds === "number") {
		const minutes = Math.floor(provenance.timestampSeconds / 60)
		const seconds = Math.floor(provenance.timestampSeconds % 60)
		return `${minutes}:${String(seconds).padStart(2, "0")}`
	}
	return ""
}

/**
 * Scope-aware semantic search in a SINGLE query: org-wide docs + the
 * caller's team(s) + the caller's personal docs, ranked by cosine distance.
 * This schema models visibility directly, so organization, team, and personal
 * results can be filtered in one query rather than merged client-side.
 */
export async function searchMemories({
	q,
	orgId,
	teamIds,
	userId,
	limit,
}: SearchParams): Promise<SearchResult[]> {
	const canUseSemantic =
		!!process.env.NVIDIA_API_KEY &&
		(await hasProviderConsent({
			orgId,
			userId,
			provider: "nvidia",
			purpose: "embeddings",
		}))
	const queryEmbedding = canUseSemantic ? await embedQuery(q) : null
	const vectorLiteral = queryEmbedding ? `[${queryEmbedding.join(",")}]` : null

	const visibility = documentVisibility({
		orgId,
		teamIds,
		userId,
		role: "member",
	})

	const selection = {
		chunkId: memoryChunks.id,
		documentId: documents.id,
		title: documents.title,
		url: documents.url,
		source: documents.source,
		scope: documents.scope,
		chunkContent: memoryChunks.content,
		chunkProvenance: memoryChunks.provenance,
		distance: vectorLiteral
			? sql<number>`${memoryChunks.embedding} <=> ${vectorLiteral}::vector`
			: sql<number>`1`,
	}
	const candidateLimit = Math.min(200, Math.max(limit * 4, 20))
	const semantic = vectorLiteral
		? await db
				.select({ ...selection })
				.from(memoryChunks)
				.innerJoin(documents, eq(documents.id, memoryChunks.documentId))
				.where(
					and(
						eq(documents.orgId, orgId),
						visibility,
						isNotNull(memoryChunks.embedding),
					),
				)
				.orderBy(sql`${memoryChunks.embedding} <=> ${vectorLiteral}::vector`)
				.limit(candidateLimit)
		: []
	const lexicalRank = sql<number>`ts_rank_cd(
		to_tsvector('english', ${memoryChunks.content}),
		websearch_to_tsquery('english', ${q})
	)`
	const lexical = await db
		.select({ ...selection, lexicalRank })
		.from(memoryChunks)
		.innerJoin(documents, eq(documents.id, memoryChunks.documentId))
		.where(and(eq(documents.orgId, orgId), visibility, sql`${lexicalRank} > 0`))
		.orderBy(sql`${lexicalRank} desc`)
		.limit(candidateLimit)

	const ranked = new Map<
		string,
		{ row: (typeof semantic)[number]; score: number }
	>()
	for (const [rank, row] of semantic.entries()) {
		ranked.set(row.chunkId, { row, score: 1 / (60 + rank + 1) })
	}
	for (const [rank, row] of lexical.entries()) {
		const current = ranked.get(row.chunkId)
		if (current) current.score += 1 / (60 + rank + 1)
		else ranked.set(row.chunkId, { row, score: 1 / (60 + rank + 1) })
	}
	return [...ranked.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ row }) => row)
}
