import { connectionIngestScope, getValidFigmaConnection } from "./connections"
import { db, documents } from "@repo/db"
import { and, eq, like, notInArray } from "drizzle-orm"
import {
	commentMessageToText,
	extractComponentDescriptions,
	getFile,
	getFileComments,
} from "./figma"
import { ingestDocument } from "./ingest"

interface FigmaMetadata {
	handle: string
	watchedFileKeys?: string[]
}

/**
 * Full re-fetch of comments + component descriptions on every sync — no
 * delta/diffing against Figma's file-level lastModified. Simple and correct
 * for MVP file counts; ponytail: add delta checks if this ever hits rate
 * limits, not before.
 *
 * Scope is "org" like Confluence — no team-to-file mapping exists yet.
 * Frame/page node "descriptions" aren't a real Figma data field (only
 * COMPONENT/COMPONENT_SET nodes have one), so that's what's actually
 * ingested, not arbitrary frames. Dev Mode annotations are skipped — the
 * REST API surface for them wasn't verified, unlike everything else here.
 */
export async function syncFigmaFile(
	orgId: string,
	fileKey: string,
	signal?: AbortSignal,
) {
	const conn = await getValidFigmaConnection(orgId)
	if (!conn) throw new Error(`No Figma connection for org ${orgId}`)

	const file = await getFile(fileKey, conn.accessToken, signal)
	const comments = await getFileComments(fileKey, conn.accessToken, signal)

	let ingestedCount = 0
	const sourceIds: string[] = []

	for (const comp of extractComponentDescriptions(file.document)) {
		const sourceId = `${fileKey}:component:${comp.nodeId}`
		sourceIds.push(sourceId)
		await ingestDocument({
			orgId,
			connectionId: conn.id,
			...connectionIngestScope(conn),
			source: "figma",
			sourceId,
			title: `${file.name} — ${comp.name}`,
			url: `https://www.figma.com/file/${fileKey}?node-id=${comp.nodeId}`,
			rawContent: comp.description,
		})
		ingestedCount++
	}

	for (const comment of comments) {
		const text = commentMessageToText(comment.message)
		if (!text.trim()) continue
		const sourceId = `${fileKey}:comment:${comment.id}`
		sourceIds.push(sourceId)
		await ingestDocument({
			orgId,
			connectionId: conn.id,
			...connectionIngestScope(conn),
			source: "figma",
			sourceId,
			title: `Comment in ${file.name}`,
			url: `https://www.figma.com/file/${fileKey}#${comment.id}`,
			rawContent: text,
			sourceUpdatedAt: new Date(comment.created_at),
		})
		ingestedCount++
	}

	const deletedRows = await db
		.delete(documents)
		.where(
			and(
				eq(documents.connectionId, conn.id),
				eq(documents.source, "figma"),
				like(documents.sourceId, `${fileKey}:%`),
				sourceIds.length
					? notInArray(documents.sourceId, sourceIds)
					: undefined,
			),
		)
		.returning({ id: documents.id })
	return { fileName: file.name, ingestedCount, deleted: deletedRows.length }
}

export async function syncAllWatchedFiles(orgId: string, signal?: AbortSignal) {
	const conn = await getValidFigmaConnection(orgId)
	if (!conn) throw new Error(`No Figma connection for org ${orgId}`)
	const metadata = conn.metadata as unknown as FigmaMetadata
	const results = []
	for (const fileKey of metadata.watchedFileKeys ?? []) {
		results.push({ fileKey, ...(await syncFigmaFile(orgId, fileKey, signal)) })
	}
	return results
}
