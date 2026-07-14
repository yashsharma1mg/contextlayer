import { db, documents, memoryChunks } from "@repo/db"
import { and, eq, or, sql } from "drizzle-orm"
import { embedQuery } from "./embeddings"

export interface SearchParams {
	q: string
	orgId: string
	teamIds: string[]
	userId: string
	limit: number
}

export interface SearchResult {
	documentId: string
	title: string
	url: string | null
	source: "confluence" | "figma" | "manual"
	scope: "org" | "team" | "personal"
	chunkContent: string
	distance: number
}

/**
 * Scope-aware semantic search in a SINGLE query: org-wide docs + the
 * caller's team(s) + the caller's personal docs, ranked by cosine distance.
 * Supermemory's own `containerTag` is a flat single string with no OR query,
 * which would force multiple calls merged client-side — we own this schema,
 * so org/team/personal visibility is just a WHERE clause.
 */
export async function searchMemories({
	q,
	orgId,
	teamIds,
	userId,
	limit,
}: SearchParams): Promise<SearchResult[]> {
	const queryEmbedding = await embedQuery(q)
	const vectorLiteral = `[${queryEmbedding.join(",")}]`

	const visibility = or(
		eq(documents.scope, "org"),
		teamIds.length > 0
			? and(
					eq(documents.scope, "team"),
					sql`${documents.teamId} = ANY(${teamIds})`,
				)
			: undefined,
		and(eq(documents.scope, "personal"), eq(documents.ownerUserId, userId)),
	)

	return db
		.select({
			documentId: documents.id,
			title: documents.title,
			url: documents.url,
			source: documents.source,
			scope: documents.scope,
			chunkContent: memoryChunks.content,
			distance: sql<number>`${memoryChunks.embedding} <=> ${vectorLiteral}::vector`,
		})
		.from(memoryChunks)
		.innerJoin(documents, eq(documents.id, memoryChunks.documentId))
		.where(and(eq(documents.orgId, orgId), visibility))
		.orderBy(sql`${memoryChunks.embedding} <=> ${vectorLiteral}::vector`)
		.limit(limit)
}
