import { db, documents, memoryChunks } from "@repo/db"
import { eq } from "drizzle-orm"
import { chunkText } from "./chunking"
import { embedPassages } from "./embeddings"
import { filterSignal } from "./understand"

export interface IngestInput {
	orgId: string
	teamId?: string
	ownerUserId?: string
	scope: "org" | "team" | "personal"
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
	sourceId: string
	title: string
	url?: string
	rawContent: string
	mimeType?: string
	storageKey?: string
	provenance?: Record<string, unknown>
	sourceUpdatedAt?: Date
}

/** Shared by the manual POST /api/memories route and connector sync jobs (Confluence, Figma). */
export async function ingestDocument(input: IngestInput) {
	const [doc] = await db
		.insert(documents)
		.values(input)
		.onConflictDoUpdate({
			target: [documents.orgId, documents.source, documents.sourceId],
			set: {
				title: input.title,
				url: input.url,
				rawContent: input.rawContent,
				sourceUpdatedAt: input.sourceUpdatedAt,
				updatedAt: new Date(),
			},
		})
		.returning()

	if (!doc) throw new Error("document upsert returned no row")

	// Re-ingestion: drop old chunks, re-chunk + re-embed from scratch.
	// Fine for MVP; a real diffing/dedup pass can come later if needed.
	await db.delete(memoryChunks).where(eq(memoryChunks.documentId, doc.id))

	const chunks = chunkText(input.rawContent)
	// Understanding pass: filter noise out before it ever reaches the vector
	// store, source-agnostic (Confluence, Figma, and uploads all go through
	// the same filter here).
	const signalChunks = await filterSignal(chunks)
	if (signalChunks.length > 0) {
		const embeddings = await embedPassages(signalChunks)
		await db.insert(memoryChunks).values(
			signalChunks.map((content, i) => ({
				documentId: doc.id,
				chunkIndex: i,
				content,
				embedding: embeddings[i] as number[],
			})),
		)
	}

	return {
		document: doc,
		chunkCount: signalChunks.length,
		noiseFiltered: chunks.length - signalChunks.length,
	}
}
