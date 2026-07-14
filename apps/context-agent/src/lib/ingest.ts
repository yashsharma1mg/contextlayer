import { db, documents, memoryChunks, sourceAccessGrants } from "@repo/db"
import { eq } from "drizzle-orm"
import { chunkText } from "./chunking"
import { embedPassages } from "./embeddings"
import { signalChunkIndexes } from "./understand"
import { hasProviderConsent } from "./provider-consent"

export interface IngestSection {
	text: string
	provenance: Record<string, unknown>
}

export interface IngestInput {
	orgId: string
	createdBy?: string
	consentUserId?: string
	connectionId?: string
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
	sections?: IngestSection[]
	mimeType?: string
	storageKey?: string
	provenance?: Record<string, unknown>
	metadata?: Record<string, unknown>
	sourceUpdatedAt?: Date
}

/** Shared by the manual POST /api/memories route and connector sync jobs (Confluence, Figma). */
export async function ingestDocument(input: IngestInput) {
	const chunks = input.sections?.length
		? input.sections.flatMap((section) =>
				chunkText(section.text).map((content) => ({
					content,
					provenance: section.provenance,
				})),
			)
		: chunkText(input.rawContent).map((content) => ({
				content,
				provenance: {},
			}))
	const canFilter =
		!!process.env.OPENROUTER_API_KEY &&
		(await hasProviderConsent({
			orgId: input.orgId,
			userId: input.consentUserId,
			provider: "openrouter",
			purpose: "generation",
		}))
	const signalIndexes = canFilter
		? await signalChunkIndexes(chunks.map(({ content }) => content))
		: chunks.map((_, index) => index)
	const signalChunks = signalIndexes.map(
		(index) => chunks[index] as (typeof chunks)[number],
	)
	const canEmbed =
		!!process.env.NVIDIA_API_KEY &&
		(await hasProviderConsent({
			orgId: input.orgId,
			userId: input.consentUserId,
			provider: "nvidia",
			purpose: "embeddings",
		}))
	let embeddings: number[][] | null = null
	if (canEmbed && signalChunks.length > 0) {
		try {
			embeddings = await embedPassages(
				signalChunks.map(({ content }) => content),
			)
		} catch (error) {
			console.error(
				"Embedding enrichment failed; keeping lexical chunks",
				error,
			)
		}
	}
	const principal =
		input.scope === "team"
			? { kind: "team" as const, id: input.teamId }
			: input.scope === "personal"
				? { kind: "user" as const, id: input.ownerUserId }
				: { kind: "organization" as const, id: input.orgId }
	if (!principal.id)
		throw new Error(`Missing principal for ${input.scope} scope`)
	const principalId = principal.id
	const doc = await db.transaction(async (tx) => {
		const [upserted] = await tx
			.insert(documents)
			.values(input)
			.onConflictDoUpdate({
				target: [
					documents.orgId,
					documents.connectionId,
					documents.source,
					documents.sourceId,
				],
				set: {
					createdBy: input.createdBy,
					teamId: input.teamId,
					ownerUserId: input.ownerUserId,
					scope: input.scope,
					title: input.title,
					url: input.url,
					rawContent: input.rawContent,
					mimeType: input.mimeType,
					storageKey: input.storageKey,
					provenance: input.provenance,
					metadata: input.metadata,
					sourceUpdatedAt: input.sourceUpdatedAt,
					updatedAt: new Date(),
				},
			})
			.returning()
		if (!upserted) throw new Error("document upsert returned no row")
		await tx
			.delete(sourceAccessGrants)
			.where(eq(sourceAccessGrants.documentId, upserted.id))
		await tx.insert(sourceAccessGrants).values({
			documentId: upserted.id,
			principalKind: principal.kind,
			principalId,
		})
		await tx
			.delete(memoryChunks)
			.where(eq(memoryChunks.documentId, upserted.id))
		if (signalChunks.length > 0) {
			await tx.insert(memoryChunks).values(
				signalChunks.map((chunk, index) => ({
					documentId: upserted.id,
					chunkIndex: index,
					content: chunk.content,
					provenance: chunk.provenance,
					embedding: embeddings?.[index] ?? null,
				})),
			)
		}
		return upserted
	})

	return {
		document: doc,
		chunkCount: signalChunks.length,
		noiseFiltered: chunks.length - signalChunks.length,
	}
}
