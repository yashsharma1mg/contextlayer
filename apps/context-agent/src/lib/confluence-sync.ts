import {
	adfToText,
	findPagesUpdatedSince,
	listAllPages,
	listGlobalSpaces,
} from "./confluence"
import { db, documents } from "@repo/db"
import { and, eq, notInArray } from "drizzle-orm"
import {
	connectionIngestScope,
	getValidConfluenceConnection,
	updateConnectionMetadata,
} from "./connections"
import { ingestDocument } from "./ingest"

interface ConfluenceMetadata {
	cloudId: string
	siteUrl: string
	lastPolledAt?: string
	lastFullScanAt?: string
}

/**
 * Syncs an org's Confluence connection: every global space, pages new since
 * the last poll (full backfill on first run). Personal spaces are skipped —
 * see confluence.ts for why. Scope is "org" for all ingested pages; a
 * team-to-space mapping doesn't exist yet, so this doesn't pretend to have
 * team-level granularity it can't actually enforce.
 */
export async function syncConfluenceConnection(
	orgId: string,
	signal?: AbortSignal,
) {
	const conn = await getValidConfluenceConnection(orgId)
	if (!conn) throw new Error(`No Confluence connection for org ${orgId}`)

	const metadata = conn.metadata as unknown as ConfluenceMetadata
	const { cloudId } = metadata
	const lastPolledAt = metadata.lastPolledAt
		? new Date(metadata.lastPolledAt)
		: null
	const fullScan =
		!metadata.lastFullScanAt ||
		Date.now() - new Date(metadata.lastFullScanAt).getTime() > 24 * 60 * 60_000

	const spaces = await listGlobalSpaces(cloudId, conn.accessToken, signal)

	let ingestedCount = 0
	const sourceIds: string[] = []
	for (const space of spaces) {
		const pages =
			!fullScan && lastPolledAt
				? await findPagesUpdatedSince(
						cloudId,
						conn.accessToken,
						space.key,
						lastPolledAt,
						signal,
					)
				: await listAllPages(cloudId, conn.accessToken, space.id, signal)

		for (const page of pages) {
			if (fullScan) sourceIds.push(page.id)
			const text = adfToText(page.adfBody)
			if (!text.trim()) continue
			await ingestDocument({
				orgId,
				connectionId: conn.id,
				...connectionIngestScope(conn),
				source: "confluence",
				sourceId: page.id,
				title: page.title,
				url: page.url,
				rawContent: text,
				sourceUpdatedAt: new Date(page.updatedAt),
			})
			ingestedCount++
		}
	}
	let deleted = 0
	if (fullScan) {
		const rows = await db
			.delete(documents)
			.where(
				and(
					eq(documents.connectionId, conn.id),
					eq(documents.source, "confluence"),
					sourceIds.length
						? notInArray(documents.sourceId, sourceIds)
						: undefined,
				),
			)
			.returning({ id: documents.id })
		deleted = rows.length
	}

	await updateConnectionMetadata(conn.id, {
		...metadata,
		lastPolledAt: new Date().toISOString(),
		...(fullScan ? { lastFullScanAt: new Date().toISOString() } : {}),
	})

	return { spacesChecked: spaces.length, pagesIngested: ingestedCount, deleted }
}
