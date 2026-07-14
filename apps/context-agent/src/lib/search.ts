import { db, documents, memoryChunks } from "@repo/db"
import { and, eq, sql } from "drizzle-orm"
import { documentVisibility } from "./access-policy"
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
	distance: number
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
	const queryEmbedding = await embedQuery(q)
	const vectorLiteral = `[${queryEmbedding.join(",")}]`

	const visibility = documentVisibility({
		orgId,
		teamIds,
		userId,
		role: "member",
	})

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
