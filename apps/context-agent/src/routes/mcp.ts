import { zValidator } from "@hono/zod-validator"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import {
	canvasEdges,
	canvasNodes,
	canvases,
	db,
	designAssets,
	documents,
	mcpTokens,
} from "@repo/db"
import { and, eq, gt, isNull, or } from "drizzle-orm"
import { Hono } from "hono"
import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import * as z4 from "zod/v4"
import { callerForIdentity, type Caller, requireCaller } from "../lib/caller"
import { documentVisibility } from "../lib/access-policy"
import { getVisibleProject } from "../lib/project-access"
import { searchMemories } from "../lib/search"

export const mcpRoute = new Hono()
export const mcpTokensRoute = new Hono()

const readScopes = ["knowledge:read", "canvas:read", "design:read"]
type McpInput = Record<string, unknown>

function mcpSchema(shape: Record<string, unknown>) {
	return shape as unknown as Record<string, AnySchema>
}

function mcpHandler<T>(handler: (args: McpInput) => T) {
	return handler as unknown as never
}

function hash(token: string) {
	return createHash("sha256").update(token).digest("hex")
}

function jsonContent(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	}
}

async function bearerCaller(request: Request): Promise<Caller | null> {
	const authorization = request.headers.get("authorization")
	const token = authorization?.startsWith("Bearer ")
		? authorization.slice(7)
		: null
	if (!token) return null
	const [row] = await db
		.select()
		.from(mcpTokens)
		.where(
			and(
				eq(mcpTokens.tokenHash, hash(token)),
				or(gt(mcpTokens.expiresAt, new Date()), isNull(mcpTokens.expiresAt)),
			),
		)
	if (!row || !row.scopes.some((scope) => readScopes.includes(scope)))
		return null
	const caller = await callerForIdentity(row.orgId, row.userId)
	if (!caller) return null
	await db
		.update(mcpTokens)
		.set({ lastUsedAt: new Date() })
		.where(eq(mcpTokens.id, row.id))
	return caller
}

function serverFor(caller: Caller) {
	const server = new McpServer({ name: "context-layer", version: "0.1.0" })
	server.registerResource(
		"active-context",
		`contextlayer://organizations/${caller.orgId}/context`,
		{
			mimeType: "application/json",
			description: "Authenticated Context Layer organization context",
		},
		async () => ({
			contents: [
				{
					uri: `contextlayer://organizations/${caller.orgId}/context`,
					mimeType: "application/json",
					text: JSON.stringify({
						organizationId: caller.orgId,
						userId: caller.userId,
					}),
				},
			],
		}),
	)
	server.registerTool(
		"search_knowledge",
		{
			description: "Search knowledge the authenticated user can access.",
			inputSchema: mcpSchema({
				query: z4.string().min(1).max(8_000),
				limit: z4.number().int().min(1).max(20).optional(),
			}),
		},
		mcpHandler(async (args) => {
			const input = z
				.object({
					query: z.string().min(1),
					limit: z.number().int().optional(),
				})
				.parse(args)
			return jsonContent(
				await searchMemories({
					q: input.query,
					limit: input.limit ?? 8,
					...caller,
				}),
			)
		}),
	)
	server.registerTool(
		"get_project_canvas",
		{
			description:
				"Read the project canvas, its nodes, and its typed relationships.",
			inputSchema: mcpSchema({ projectId: z4.string().min(1) }),
		},
		mcpHandler(async (args) => {
			const { projectId } = z
				.object({ projectId: z.string().min(1) })
				.parse(args)
			const project = await getVisibleProject(projectId, caller)
			if (!project) return jsonContent({ error: "Project not found" })
			const [canvas] = await db
				.select()
				.from(canvases)
				.where(eq(canvases.projectId, project.id))
				.limit(1)
			if (!canvas) return jsonContent({ project, canvas: null, nodes: [] })
			const nodes = await db
				.select()
				.from(canvasNodes)
				.where(eq(canvasNodes.canvasId, canvas.id))
			const edges = await db
				.select()
				.from(canvasEdges)
				.where(eq(canvasEdges.canvasId, canvas.id))
			return jsonContent({ project, canvas, nodes, edges })
		}),
	)
	server.registerTool(
		"list_design_assets",
		{
			description:
				"List the approved assets in a project's pinned design-system version.",
			inputSchema: mcpSchema({ projectId: z4.string().min(1) }),
		},
		mcpHandler(async (args) => {
			const { projectId } = z
				.object({ projectId: z.string().min(1) })
				.parse(args)
			const project = await getVisibleProject(projectId, caller)
			if (!project) return jsonContent({ error: "Project not found" })
			if (!project.pinnedDesignSystemVersionId)
				return jsonContent({ versionId: null, assets: [] })
			const assets = await db
				.select()
				.from(designAssets)
				.where(eq(designAssets.versionId, project.pinnedDesignSystemVersionId))
			return jsonContent({
				versionId: project.pinnedDesignSystemVersionId,
				assets,
			})
		}),
	)
	server.registerTool(
		"get_document",
		{
			description:
				"Read one knowledge document when it belongs to the authenticated organization.",
			inputSchema: mcpSchema({ documentId: z4.string().min(1) }),
		},
		mcpHandler(async (args) => {
			const { documentId } = z
				.object({ documentId: z.string().min(1) })
				.parse(args)
			const [document] = await db
				.select()
				.from(documents)
				.where(
					and(
						eq(documents.id, documentId),
						eq(documents.orgId, caller.orgId),
						documentVisibility(caller),
					),
				)
			if (!document) return jsonContent({ error: "Document not found" })
			return jsonContent(document)
		}),
	)
	return server
}

mcpRoute.all("/", async (c) => {
	const caller = await bearerCaller(c.req.raw)
	if (!caller) return c.json({ error: "Valid MCP bearer token required" }, 401)
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
	})
	const server = serverFor(caller)
	await server.connect(transport)
	return transport.handleRequest(c.req.raw)
})

mcpTokensRoute.post(
	"/tokens",
	zValidator(
		"json",
		z.object({
			name: z.string().trim().min(1).max(120),
			expiresInDays: z.number().int().min(1).max(90).default(30),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		const input = c.req.valid("json")
		const token = `clm_${randomBytes(32).toString("base64url")}`
		const [created] = await db
			.insert(mcpTokens)
			.values({
				orgId: caller.orgId,
				userId: caller.userId,
				name: input.name,
				tokenHash: hash(token),
				scopes: readScopes,
				expiresAt: new Date(
					Date.now() + input.expiresInDays * 24 * 60 * 60_000,
				),
			})
			.returning({ id: mcpTokens.id, expiresAt: mcpTokens.expiresAt })
		return c.json({ token, ...created }, 201)
	},
)
