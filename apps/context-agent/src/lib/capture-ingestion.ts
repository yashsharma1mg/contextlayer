import {
	canvasNodes,
	canvases,
	captures,
	db,
	projectMembers,
	projects,
	sourceAccessGrants,
} from "@repo/db"
import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { enqueueJob } from "./background-jobs"
import { captureOutlineText } from "./capture-redaction"
import { ingestDocument } from "./ingest"

const payloadSchema = z.object({ captureId: z.string().min(1) })

async function updateCaptureNodes(
	captureId: string,
	data: Record<string, unknown>,
	documentId?: string,
) {
	const nodes = await db
		.select({ id: canvasNodes.id, data: canvasNodes.data })
		.from(canvasNodes)
		.where(eq(canvasNodes.captureId, captureId))
	for (const node of nodes) {
		await db
			.update(canvasNodes)
			.set({
				data: { ...node.data, ...data },
				...(documentId ? { documentId } : {}),
				version: sql`${canvasNodes.version} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(canvasNodes.id, node.id))
	}
}

export async function syncProjectCaptureGrants(
	projectId: string,
	documentId?: string,
) {
	const [project, members, linked] = await Promise.all([
		db.select().from(projects).where(eq(projects.id, projectId)).limit(1),
		db
			.select({ userId: projectMembers.userId })
			.from(projectMembers)
			.where(eq(projectMembers.projectId, projectId)),
		documentId
			? Promise.resolve([{ documentId }])
			: db
					.selectDistinct({ documentId: canvasNodes.documentId })
					.from(canvasNodes)
					.innerJoin(canvases, eq(canvases.id, canvasNodes.canvasId))
					.where(
						and(
							eq(canvases.projectId, projectId),
							eq(canvasNodes.kind, "capture"),
						),
					),
	])
	const current = project[0]
	if (!current) throw new Error("Capture project not found")
	const documentIds = linked
		.map((item) => item.documentId)
		.filter((id): id is string => !!id)
	if (!documentIds.length) return

	type Grant = { kind: "organization" | "team" | "user"; id: string }
	const grants = new Map<string, Grant>()
	const add = (kind: Grant["kind"], id?: string | null) => {
		if (id) grants.set(`${kind}:${id}`, { kind, id })
	}
	if (current.visibility === "org") add("organization", current.orgId)
	else if (current.visibility === "team") add("team", current.teamId)
	add("user", current.ownerUserId)
	for (const member of members) add("user", member.userId)

	await db.transaction(async (tx) => {
		await tx
			.delete(sourceAccessGrants)
			.where(inArray(sourceAccessGrants.documentId, documentIds))
		await tx.insert(sourceAccessGrants).values(
			documentIds.flatMap((id) =>
				[...grants.values()].map((grant) => ({
					documentId: id,
					principalKind: grant.kind,
					principalId: grant.id,
				})),
			),
		)
	})
}

export async function enqueueCaptureIngestion(input: {
	captureId: string
	orgId: string
	projectId: string
	userId: string
}) {
	const job = await enqueueJob({
		orgId: input.orgId,
		projectId: input.projectId,
		createdBy: input.userId,
		type: "capture.ingest",
		payload: { captureId: input.captureId },
		idempotencyKey: input.captureId,
	})
	await updateCaptureNodes(input.captureId, {
		processingJobId: job.id,
		processingStatus: job.status,
	})
	return job
}

export async function ingestCapture(
	payload: Record<string, unknown>,
	progress: (value: number) => Promise<void>,
) {
	const { captureId } = payloadSchema.parse(payload)
	const [record] = await db
		.select({ capture: captures, project: projects })
		.from(captures)
		.innerJoin(projects, eq(projects.id, captures.projectId))
		.where(eq(captures.id, captureId))
		.limit(1)
	if (!record) throw new Error("Capture not found")
	await updateCaptureNodes(captureId, { processingStatus: "running" })
	await progress(15)
	const text = captureOutlineText(record.capture.domOutline)
	if (!text) throw new Error("Capture contains no searchable content")
	const result = await ingestDocument({
		orgId: record.project.orgId,
		createdBy: record.capture.authorUserId,
		consentUserId: record.capture.authorUserId,
		ownerUserId: record.project.ownerUserId,
		scope: "personal",
		source: "capture",
		sourceId: record.capture.id,
		title: record.capture.title,
		url: record.capture.url,
		rawContent: text,
		sections: [
			{
				text,
				provenance: {
					captureId,
					url: record.capture.url,
					...record.capture.metadata,
				},
			},
		],
		mimeType: "application/vnd.context-layer.capture+json",
		storageKey: record.capture.domObjectId ?? undefined,
		provenance: {
			captureId,
			domObjectId: record.capture.domObjectId,
			screenshotObjectId: record.capture.screenshotObjectId,
			...record.capture.metadata,
		},
	})
	await progress(80)
	await syncProjectCaptureGrants(record.project.id, result.document.id)
	await updateCaptureNodes(
		captureId,
		{ processingStatus: "succeeded", processingError: null },
		result.document.id,
	)
	return { documentId: result.document.id, chunkCount: result.chunkCount }
}

export async function markCaptureIngestionFailed(
	payload: Record<string, unknown>,
	error: unknown,
) {
	const parsed = payloadSchema.safeParse(payload)
	if (!parsed.success) return
	await updateCaptureNodes(parsed.data.captureId, {
		processingStatus: "failed",
		processingError: error instanceof Error ? error.message : String(error),
	})
}
