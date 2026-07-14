import { zValidator } from "@hono/zod-validator"
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client"
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
	artifactRevisions,
	generatedFileSets,
	ideas,
	mcpTokens,
	publicationAudits,
} from "@repo/db"
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm"
import { Hono } from "hono"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import * as z4 from "zod/v4"
import { callerForIdentity, type Caller, requireCaller } from "../lib/caller"
import { mcpScopes } from "../auth"
import { documentVisibility } from "../lib/access-policy"
import {
	getProjectAccess,
	getVisibleProject,
	projectRoleAllows,
} from "../lib/project-access"
import { searchMemories } from "../lib/search"
import {
	uiPlanSchema,
	validateUiPlan,
	validateUiPlanCitations,
} from "../lib/ui-plan"
import { reactFilesFromUiPlan } from "../lib/react-source"
import { validateGeneratedFiles } from "../lib/prototype-validation"
import {
	publicationBranch,
	validateGitHubPublication,
} from "../lib/publish-github"
import { enqueueJob } from "../lib/background-jobs"
import { requireMcpScope } from "../lib/mcp-scopes"

export const mcpRoute = new Hono()
export const mcpTokensRoute = new Hono()

type McpScope = (typeof mcpScopes)[number]
const readScopes: McpScope[] = ["knowledge:read", "canvas:read", "design:read"]
type McpInput = Record<string, unknown>
type McpPrincipal = { caller: Caller; scopes: Set<string> }

const mcpAudience = `${process.env.BETTER_AUTH_URL ?? "http://localhost:8787"}/mcp`
const authIssuer = `${process.env.BETTER_AUTH_URL ?? "http://localhost:8787"}/api/auth`
const oauthVerifier = oauthProviderResourceClient().getActions()
	.verifyAccessToken as unknown as (
	token: string,
	options: {
		verifyOptions: { audience: string; issuer: string }
		jwksUrl: string
	},
) => Promise<Record<string, unknown>>

export async function protectedResourceMetadata() {
	return {
		resource: mcpAudience,
		authorization_servers: [authIssuer],
		scopes_supported: [...mcpScopes],
		resource_name: "Context Layer MCP",
		bearer_methods_supported: ["header"],
	}
}

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

async function bearerPrincipal(request: Request): Promise<McpPrincipal | null> {
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
	if (row) {
		const caller = await callerForIdentity(row.orgId, row.userId)
		if (!caller) return null
		await db
			.update(mcpTokens)
			.set({ lastUsedAt: new Date() })
			.where(eq(mcpTokens.id, row.id))
		return { caller, scopes: new Set(row.scopes) }
	}
	try {
		const payload = await oauthVerifier(token, {
			verifyOptions: { audience: mcpAudience, issuer: authIssuer },
			jwksUrl: `${authIssuer}/jwks`,
		})
		const orgId = typeof payload.org_id === "string" ? payload.org_id : null
		if (!orgId || typeof payload.sub !== "string") return null
		const caller = await callerForIdentity(orgId, payload.sub)
		if (!caller) return null
		const scopes = new Set<string>(
			typeof payload.scope === "string"
				? payload.scope.split(/\s+/).filter(Boolean)
				: [],
		)
		return { caller, scopes }
	} catch {
		return null
	}
}

function serverFor({ caller, scopes }: McpPrincipal) {
	const server = new McpServer({ name: "context-layer", version: "0.1.0" })
	const requireScope = (scope: McpScope) => requireMcpScope(scopes, scope)
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
			requireScope("knowledge:read")
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
			requireScope("canvas:read")
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
		"get_artifact",
		{
			description:
				"Read a project artifact and its latest immutable revision, including any validated UI plan.",
			inputSchema: mcpSchema({ artifactId: z4.string().min(1) }),
		},
		mcpHandler(async (args) => {
			requireScope("canvas:read")
			const { artifactId } = z
				.object({ artifactId: z.string().min(1) })
				.parse(args)
			const [artifact] = await db
				.select()
				.from(ideas)
				.where(eq(ideas.id, artifactId))
				.limit(1)
			if (!artifact || !(await getVisibleProject(artifact.projectId, caller))) {
				return jsonContent({ error: "Artifact not found" })
			}
			const [revision] = await db
				.select()
				.from(artifactRevisions)
				.where(eq(artifactRevisions.artifactId, artifact.id))
				.orderBy(desc(artifactRevisions.version))
				.limit(1)
			return jsonContent({ artifact, revision: revision ?? null })
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
			requireScope("design:read")
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
		"generate_react_prototype",
		{
			description:
				"Validate a UI plan against the pinned manifest and create a multi-file React prototype artifact.",
			inputSchema: mcpSchema({
				projectId: z4.string().min(1),
				plan: z4.record(z4.string(), z4.unknown()),
			}),
		},
		mcpHandler(async (args) => {
			requireScope("generation:write")
			requireScope("artifacts:write")
			const input = z
				.object({ projectId: z.string().min(1), plan: z.record(z.unknown()) })
				.parse(args)
			const plan = uiPlanSchema.parse(input.plan)
			const access = await getProjectAccess(input.projectId, caller)
			if (!access || !projectRoleAllows(access.role, "editor")) {
				return jsonContent({ error: "Project editor access required" })
			}
			const versionId = access.project.pinnedDesignSystemVersionId
			if (!versionId)
				return jsonContent({ error: "Project has no pinned design system" })
			const assets = await db
				.select({
					id: designAssets.id,
					name: designAssets.name,
					kind: designAssets.kind,
					data: designAssets.data,
					importPath: designAssets.importPath,
					exportName: designAssets.exportName,
				})
				.from(designAssets)
				.where(eq(designAssets.versionId, versionId))
			const mappedAssets = assets.map((asset) => ({
				id: asset.id,
				name: asset.name,
				kind: asset.kind,
				data: {
					...asset.data,
					importPath: asset.importPath,
					exportName: asset.exportName,
				},
			}))
			const errors = validateUiPlan(plan, mappedAssets, versionId)
			const approvedImports = mappedAssets.flatMap((asset) =>
				typeof asset.data.importPath === "string"
					? [asset.data.importPath]
					: [],
			)
			const files = errors.length
				? []
				: reactFilesFromUiPlan(plan, mappedAssets)
			errors.push(...validateGeneratedFiles(files, approvedImports))
			const citationIds = [
				...new Set(plan.citations.map((citation) => citation.documentId)),
			]
			const citationRows = citationIds.length
				? await db
						.select({
							id: documents.id,
							title: documents.title,
							url: documents.url,
						})
						.from(documents)
						.where(
							and(
								eq(documents.orgId, caller.orgId),
								inArray(documents.id, citationIds),
								documentVisibility(caller),
							),
						)
				: []
			if (citationRows.length !== citationIds.length) {
				errors.push("One or more citations are unavailable")
			}
			errors.push(
				...validateUiPlanCitations(
					plan,
					citationRows.map((source) => ({ documentId: source.id })),
					{ required: true },
				),
			)
			if (errors.length) return jsonContent({ valid: false, errors })
			let [canvas] = await db
				.select()
				.from(canvases)
				.where(eq(canvases.projectId, access.project.id))
				.limit(1)
			if (!canvas) {
				;[canvas] = await db
					.insert(canvases)
					.values({ projectId: access.project.id, name: "Workspace" })
					.returning()
			}
			if (!canvas) throw new Error("Canvas creation failed")
			const artifact = await db.transaction(async (tx) => {
				const [idea] = await tx
					.insert(ideas)
					.values({
						projectId: access.project.id,
						authorUserId: caller.userId,
						kind: "react_prototype",
						title: plan.title,
						body: plan.summary,
						generatedCode: files
							.map((file) => `// ${file.path}\n${file.content}`)
							.join("\n\n"),
						prompt: "MCP validated React generation",
						sourceRefs: citationRows.map((source) => ({
							documentId: source.id,
							title: source.title,
							url: source.url,
						})),
					})
					.returning()
				if (!idea) throw new Error("Artifact creation failed")
				await tx.insert(artifactRevisions).values({
					artifactId: idea.id,
					version: 1,
					authorUserId: caller.userId,
					title: idea.title,
					content: { body: idea.body, generatedCode: idea.generatedCode },
					generationInput: { uiPlan: plan, source: "mcp" },
					sourceRefs: idea.sourceRefs ?? [],
				})
				await tx.insert(generatedFileSets).values({
					artifactId: idea.id,
					targetFramework: plan.targetFramework,
					files,
					validation: {
						manifestVersionId: versionId,
						citations: plan.citations,
						approvedImports,
						compiled: false,
					},
				})
				const [node] = await tx
					.insert(canvasNodes)
					.values({
						canvasId: canvas.id,
						kind: "artifact",
						artifactId: idea.id,
						label: idea.title,
						x: 420,
						y: 140,
						width: 520,
						height: 460,
						data: { artifactKind: "react_prototype", codeFormat: "tsx" },
					})
					.returning()
				return { idea, node }
			})
			return jsonContent({
				valid: true,
				artifact,
				files: files.map((file) => file.path),
			})
		}),
	)
	server.registerTool(
		"publish_react_prototype",
		{
			description:
				"Publish an explicitly approved React prototype through the configured local GitHub CLI.",
			inputSchema: mcpSchema({
				artifactId: z4.string().min(1),
				approved: z4.literal(true),
			}),
		},
		mcpHandler(async (args) => {
			requireScope("publication:write")
			const input = z
				.object({ artifactId: z.string().min(1), approved: z.literal(true) })
				.parse(args)
			const [artifact] = await db
				.select()
				.from(ideas)
				.where(eq(ideas.id, input.artifactId))
				.limit(1)
			if (!artifact) return jsonContent({ error: "Artifact not found" })
			const access = await getProjectAccess(artifact.projectId, caller)
			if (!access || access.role !== "owner") {
				return jsonContent({ error: "Project owner access required" })
			}
			const context = await validateGitHubPublication(artifact.id)
			if (context.errors.length || !context.repositoryReady) {
				return jsonContent({
					error: context.errors.join("; ") || "Repository is not ready",
				})
			}
			const branch = publicationBranch(
				context.project.name,
				context.artifact.title,
				randomUUID(),
			)
			const [audit] = await db
				.insert(publicationAudits)
				.values({
					projectId: context.project.id,
					artifactId: context.artifact.id,
					approvedBy: caller.userId,
					repository: context.settings.repository,
					branch,
					status: "queued",
					validation: context.fileSet.validation,
				})
				.returning()
			if (!audit) throw new Error("Publication audit creation failed")
			const job = await enqueueJob({
				orgId: caller.orgId,
				projectId: context.project.id,
				createdBy: caller.userId,
				type: "github.publish",
				payload: { auditId: audit.id },
				idempotencyKey: audit.id,
				maxAttempts: 1,
			})
			return jsonContent({ approved: input.approved, audit, job })
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
			requireScope("knowledge:read")
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
	const principal = await bearerPrincipal(c.req.raw)
	if (!principal) {
		return c.json({ error: "Valid MCP bearer token required" }, 401, {
			"WWW-Authenticate": `Bearer resource_metadata="${process.env.BETTER_AUTH_URL ?? "http://localhost:8787"}/.well-known/oauth-protected-resource/mcp"`,
		})
	}
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
	})
	const server = serverFor(principal)
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
			scopes: z.array(z.enum(mcpScopes)).min(1).default(readScopes),
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
				scopes: input.scopes,
				expiresAt: new Date(
					Date.now() + input.expiresInDays * 24 * 60 * 60_000,
				),
			})
			.returning({ id: mcpTokens.id, expiresAt: mcpTokens.expiresAt })
		return c.json({ token, ...created }, 201)
	},
)

mcpTokensRoute.get("/tokens", async (c) => {
	const caller = await requireCaller(c)
	const tokens = await db
		.select({
			id: mcpTokens.id,
			name: mcpTokens.name,
			scopes: mcpTokens.scopes,
			expiresAt: mcpTokens.expiresAt,
			lastUsedAt: mcpTokens.lastUsedAt,
			createdAt: mcpTokens.createdAt,
		})
		.from(mcpTokens)
		.where(
			and(
				eq(mcpTokens.orgId, caller.orgId),
				eq(mcpTokens.userId, caller.userId),
			),
		)
		.orderBy(desc(mcpTokens.createdAt))
	return c.json({ tokens })
})

mcpTokensRoute.delete("/tokens/:id", async (c) => {
	const caller = await requireCaller(c)
	const [token] = await db
		.delete(mcpTokens)
		.where(
			and(
				eq(mcpTokens.id, c.req.param("id")),
				eq(mcpTokens.orgId, caller.orgId),
				eq(mcpTokens.userId, caller.userId),
			),
		)
		.returning({ id: mcpTokens.id })
	if (!token) return c.json({ error: "MCP token not found" }, 404)
	return c.json({ revoked: true })
})
