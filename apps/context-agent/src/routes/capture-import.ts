import { zValidator } from "@hono/zod-validator"
import {
	canvasEdges,
	canvasComments,
	canvasNodes,
	canvasRevisions,
	canvases,
	captures,
	captureTokens,
	db,
	projects,
} from "@repo/db"
import { and, eq, gt, sql } from "drizzle-orm"
import { Hono } from "hono"
import { createHash } from "node:crypto"
import { z } from "zod"
import { enqueueCaptureIngestion } from "../lib/capture-ingestion"
import { redactCaptureOutline } from "../lib/capture-redaction"
import { storeObject } from "../lib/local-storage"

export const captureImportRoute = new Hono()

const captureSchema = z.object({
	projectId: z.string(),
	title: z.string().trim().min(1).max(240),
	url: z.string().url(),
	domOutline: z.string().min(1).max(500_000),
	screenshot: z.string().startsWith("data:image/").max(10_000_000).optional(),
	metadata: z.record(z.unknown()).default({}),
	previousCaptureId: z.string().optional(),
})

function hash(token: string) {
	return createHash("sha256").update(token).digest("hex")
}

captureImportRoute.post(
	"/import",
	zValidator("json", captureSchema),
	async (c) => {
		const authorization = c.req.header("authorization")
		const token = authorization?.startsWith("Bearer ")
			? authorization.slice(7)
			: null
		if (!token) return c.json({ error: "Capture token required" }, 401)
		const input = c.req.valid("json")
		const [captureToken] = await db
			.select({
				id: captureTokens.id,
				projectId: captureTokens.projectId,
				createdBy: captureTokens.createdBy,
				orgId: projects.orgId,
			})
			.from(captureTokens)
			.innerJoin(projects, eq(projects.id, captureTokens.projectId))
			.where(
				and(
					eq(captureTokens.projectId, input.projectId),
					eq(captureTokens.tokenHash, hash(token)),
					gt(captureTokens.expiresAt, new Date()),
				),
			)
		if (!captureToken)
			return c.json({ error: "Capture token is invalid or expired" }, 401)

		let [canvas] = await db
			.select()
			.from(canvases)
			.where(eq(canvases.projectId, input.projectId))
			.limit(1)
		if (!canvas) {
			;[canvas] = await db
				.insert(canvases)
				.values({ projectId: input.projectId, name: "Workspace" })
				.returning()
		}
		if (!canvas) throw new Error("Canvas creation returned no row")
		const [nodes, edges, comments] = await Promise.all([
			db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvas.id)),
			db.select().from(canvasEdges).where(eq(canvasEdges.canvasId, canvas.id)),
			db
				.select()
				.from(canvasComments)
				.where(eq(canvasComments.canvasId, canvas.id)),
		])
		const [revision] = await db
			.update(canvases)
			.set({
				revision: sql`${canvases.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(canvases.id, canvas.id))
			.returning({ revision: canvases.revision })
		if (!revision) throw new Error("Canvas checkpoint failed")
		await db.insert(canvasRevisions).values({
			canvasId: canvas.id,
			revision: revision.revision,
			authorUserId: captureToken.createdBy,
			reason: "add product capture",
			snapshot: { nodes, edges, comments },
		})
		const previous = input.previousCaptureId
			? await db
					.select({ id: canvasNodes.id })
					.from(canvasNodes)
					.where(
						and(
							eq(canvasNodes.canvasId, canvas.id),
							eq(canvasNodes.captureId, input.previousCaptureId),
						),
					)
					.limit(1)
			: []
		const redactedOutline = redactCaptureOutline(input.domOutline)
		const domObject = await storeObject({
			orgId: captureToken.orgId,
			kind: "capture_dom",
			data: Buffer.from(redactedOutline),
			mimeType: "application/json",
			metadata: { projectId: input.projectId, url: input.url },
		})
		const screenshotBytes = input.screenshot
			? Buffer.from(input.screenshot.split(",", 2)[1] ?? "", "base64")
			: null
		const screenshotObject = screenshotBytes?.length
			? await storeObject({
					orgId: captureToken.orgId,
					kind: "capture_screenshot",
					data: screenshotBytes,
					mimeType:
						input.screenshot?.slice(5, input.screenshot.indexOf(";")) ||
						"image/png",
					metadata: { projectId: input.projectId, url: input.url },
				})
			: null
		const result = await db.transaction(async (tx) => {
			const [capture] = await tx
				.insert(captures)
				.values({
					projectId: input.projectId,
					authorUserId: captureToken.createdBy,
					title: input.title,
					url: input.url,
					domOutline: redactedOutline,
					domObjectId: domObject.id,
					screenshotObjectId: screenshotObject?.id,
					metadata: input.metadata,
				})
				.returning()
			if (!capture) throw new Error("Capture creation returned no row")
			const [node] = await tx
				.insert(canvasNodes)
				.values({
					canvasId: canvas.id,
					kind: "capture",
					captureId: capture.id,
					label: capture.title,
					x: 120 + (Date.now() % 180),
					y: 120 + (Date.now() % 180),
					width: 360,
					height: 300,
					data: { url: capture.url },
				})
				.returning()
			if (previous[0] && node) {
				await tx.insert(canvasEdges).values({
					canvasId: canvas.id,
					sourceNodeId: previous[0].id,
					targetNodeId: node.id,
					kind: "flows_to",
				})
			}
			return { capture, node }
		})
		await db
			.update(captureTokens)
			.set({ lastUsedAt: new Date() })
			.where(eq(captureTokens.id, captureToken.id))
		const job = await enqueueCaptureIngestion({
			captureId: result.capture.id,
			orgId: captureToken.orgId,
			projectId: input.projectId,
			userId: captureToken.createdBy,
		})
		return c.json({ ...result, job }, 201)
	},
)
