import {
	adfToText,
	findPagesUpdatedSince,
	listAllPages,
	listGlobalSpaces,
} from "./confluence"
import {
	getValidConfluenceConnection,
	updateConnectionMetadata,
} from "./connections"
import { ingestDocument } from "./ingest"

interface ConfluenceMetadata {
	cloudId: string
	siteUrl: string
	lastPolledAt?: string
}

/**
 * Syncs an org's Confluence connection: every global space, pages new since
 * the last poll (full backfill on first run). Personal spaces are skipped —
 * see confluence.ts for why. Scope is "org" for all ingested pages; a
 * team-to-space mapping doesn't exist yet, so this doesn't pretend to have
 * team-level granularity it can't actually enforce.
 */
export async function syncConfluenceConnection(orgId: string) {
	const conn = await getValidConfluenceConnection(orgId)
	if (!conn) throw new Error(`No Confluence connection for org ${orgId}`)

	const metadata = conn.metadata as unknown as ConfluenceMetadata
	const { cloudId } = metadata
	const lastPolledAt = metadata.lastPolledAt
		? new Date(metadata.lastPolledAt)
		: null

	const spaces = await listGlobalSpaces(cloudId, conn.accessToken)

	let ingestedCount = 0
	for (const space of spaces) {
		const pages = lastPolledAt
			? await findPagesUpdatedSince(
					cloudId,
					conn.accessToken,
					space.key,
					lastPolledAt,
				)
			: await listAllPages(cloudId, conn.accessToken, space.id)

		for (const page of pages) {
			const text = adfToText(page.adfBody)
			if (!text.trim()) continue
			await ingestDocument({
				orgId,
				scope: "org",
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

	await updateConnectionMetadata(conn.id, {
		...metadata,
		lastPolledAt: new Date().toISOString(),
	})

	return { spacesChecked: spaces.length, pagesIngested: ingestedCount }
}
