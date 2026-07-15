import { zValidator } from "@hono/zod-validator"
import {
	connections,
	connectorCursors,
	db,
	documents,
	sourceAccessGrants,
	team,
} from "@repo/db"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
	exchangeCodeForToken,
	getAccessibleSites,
	getAuthorizeUrl,
} from "../lib/confluence"
import { updateConnectionMetadata } from "../lib/connections"
import {
	exchangeCodeForToken as exchangeFigmaCode,
	getAuthorizeUrl as getFigmaAuthorizeUrl,
	getCurrentUser as getFigmaCurrentUser,
	parseFileKey,
} from "../lib/figma"
import { requireCaller } from "../lib/caller"
import { canManageOrganization } from "../lib/organization-access"
import { deleteSecret, encryptConnectionSecret } from "../lib/secrets"
import {
	connectorAuthorizeUrl,
	exchangeConnectorCode,
	type OAuthProvider,
} from "../lib/connector-oauth"
import { enqueueJob } from "../lib/background-jobs"
import { assertPublicHttpUrl } from "../lib/safe-fetch"

export const connectionsRoute = new Hono()

type OAuthState = {
	orgId: string
	userId: string
	provider: "confluence" | "figma" | OAuthProvider
	expiresAt: number
}

function stateSecret() {
	const secret = process.env.BETTER_AUTH_SECRET
	if (!secret) throw new Error("BETTER_AUTH_SECRET is required for OAuth state")
	return secret
}

function encodeState(input: Omit<OAuthState, "expiresAt">) {
	const payload: OAuthState = { ...input, expiresAt: Date.now() + 10 * 60_000 }
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
	const signature = createHmac("sha256", stateSecret())
		.update(encoded)
		.digest("base64url")
	return `${encoded}.${signature}`
}

function decodeState(state: string) {
	const [encoded, signature] = state.split(".")
	if (!encoded || !signature) throw new Error("Invalid OAuth state")
	const expected = createHmac("sha256", stateSecret())
		.update(encoded)
		.digest("base64url")
	if (
		signature.length !== expected.length ||
		!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new Error("Invalid OAuth state signature")
	}
	const payload = JSON.parse(
		Buffer.from(encoded, "base64url").toString(),
	) as OAuthState
	if (payload.expiresAt < Date.now()) throw new Error("OAuth state expired")
	return payload
}

async function getConnectionRow(
	orgId: string,
	provider: (typeof connections.$inferSelect)["provider"],
) {
	const [conn] = await db
		.select({
			id: connections.id,
			createdBy: connections.createdBy,
			metadata: connections.metadata,
			createdAt: connections.createdAt,
		})
		.from(connections)
		.where(
			and(eq(connections.orgId, orgId), eq(connections.provider, provider)),
		)
	return conn
}

// --- Confluence ---

connectionsRoute.get("/confluence/start", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Organization owner access required" }, 403)
	}
	return c.redirect(
		getAuthorizeUrl(
			encodeState({
				orgId: caller.orgId,
				userId: caller.userId,
				provider: "confluence",
			}),
		),
	)
})

connectionsRoute.get(
	"/confluence/callback",
	zValidator("query", z.object({ code: z.string(), state: z.string() })),
	async (c) => {
		const { code, state } = c.req.valid("query")
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const { orgId, userId, provider } = decodeState(state)
		if (
			provider !== "confluence" ||
			orgId !== caller.orgId ||
			userId !== caller.userId
		) {
			return c.json({ error: "OAuth state does not match this session" }, 403)
		}

		const token = await exchangeCodeForToken(code)
		const sites = await getAccessibleSites(token.access_token)
		const site = sites[0]
		if (!site)
			throw new Error("No accessible Confluence sites for this account")

		await db
			.insert(connections)
			.values({
				orgId,
				createdBy: userId,
				provider: "confluence",
				providerAccountId: site.id,
				accessToken: encryptConnectionSecret(
					orgId,
					"confluence",
					"access",
					token.access_token,
				),
				refreshToken: encryptConnectionSecret(
					orgId,
					"confluence",
					"refresh",
					token.refresh_token,
				),
				tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				metadata: { cloudId: site.id, siteUrl: site.url },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: site.id,
					createdBy: userId,
					accessToken: encryptConnectionSecret(
						orgId,
						"confluence",
						"access",
						token.access_token,
					),
					refreshToken: encryptConnectionSecret(
						orgId,
						"confluence",
						"refresh",
						token.refresh_token,
					),
					tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
					metadata: { cloudId: site.id, siteUrl: site.url },
				},
			})

		return c.json({ connected: true, site: site.url })
	},
)

connectionsRoute.post("/confluence/sync", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Organization owner access required" }, 403)
	}
	const job = await enqueueJob({
		orgId: caller.orgId,
		createdBy: caller.userId,
		type: "connector.confluence",
		payload: { orgId: caller.orgId },
		idempotencyKey: `confluence:${caller.orgId}:${Math.floor(Date.now() / 60_000)}`,
	})
	return c.json({ job }, 202)
})

connectionsRoute.get("/confluence/status", async (c) => {
	const caller = await requireCaller(c)
	const conn = await getConnectionRow(caller.orgId, "confluence")
	return c.json({ connected: !!conn, ...conn })
})

// --- Figma ---

connectionsRoute.get("/figma/start", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Organization owner access required" }, 403)
	}
	return c.redirect(
		getFigmaAuthorizeUrl(
			encodeState({
				orgId: caller.orgId,
				userId: caller.userId,
				provider: "figma",
			}),
		),
	)
})

connectionsRoute.get(
	"/figma/callback",
	zValidator("query", z.object({ code: z.string(), state: z.string() })),
	async (c) => {
		const { code, state } = c.req.valid("query")
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const { orgId, userId, provider } = decodeState(state)
		if (
			provider !== "figma" ||
			orgId !== caller.orgId ||
			userId !== caller.userId
		) {
			return c.json({ error: "OAuth state does not match this session" }, 403)
		}

		const token = await exchangeFigmaCode(code)
		const user = await getFigmaCurrentUser(token.access_token)

		await db
			.insert(connections)
			.values({
				orgId,
				createdBy: userId,
				provider: "figma",
				providerAccountId: user.id,
				accessToken: encryptConnectionSecret(
					orgId,
					"figma",
					"access",
					token.access_token,
				),
				refreshToken: encryptConnectionSecret(
					orgId,
					"figma",
					"refresh",
					token.refresh_token,
				),
				tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				metadata: { handle: user.handle, watchedFileKeys: [] },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: user.id,
					createdBy: userId,
					accessToken: encryptConnectionSecret(
						orgId,
						"figma",
						"access",
						token.access_token,
					),
					refreshToken: encryptConnectionSecret(
						orgId,
						"figma",
						"refresh",
						token.refresh_token,
					),
					tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				},
			})

		return c.json({ connected: true, handle: user.handle })
	},
)

// Figma team/project listing isn't usable with public OAuth apps and team
// IDs aren't programmatically discoverable, so files are added one at a time
// by URL rather than auto-discovered.
connectionsRoute.post(
	"/figma/watch",
	zValidator("json", z.object({ fileUrl: z.string() })),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const { fileUrl } = c.req.valid("json")
		const orgId = caller.orgId
		const fileKey = parseFileKey(fileUrl)
		if (!fileKey) throw new Error(`Could not parse a file key from: ${fileUrl}`)

		const conn = await getConnectionRow(orgId, "figma")
		if (!conn) throw new Error(`No Figma connection for org ${orgId}`)
		const metadata = conn.metadata as {
			handle: string
			watchedFileKeys?: string[]
		}
		const watchedFileKeys = Array.from(
			new Set([...(metadata.watchedFileKeys ?? []), fileKey]),
		)
		await updateConnectionMetadata(conn.id, { ...metadata, watchedFileKeys })

		return c.json({ watching: watchedFileKeys })
	},
)

connectionsRoute.post(
	"/figma/sync",
	zValidator("json", z.object({ fileKey: z.string().optional() })),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const { fileKey } = c.req.valid("json")
		const job = await enqueueJob({
			orgId: caller.orgId,
			createdBy: caller.userId,
			type: "connector.figma",
			payload: { orgId: caller.orgId, fileKey },
			idempotencyKey: `figma:${caller.orgId}:${fileKey ?? "all"}:${Math.floor(Date.now() / 60_000)}`,
		})
		return c.json({ job }, 202)
	},
)

connectionsRoute.get("/figma/status", async (c) => {
	const caller = await requireCaller(c)
	const conn = await getConnectionRow(caller.orgId, "figma")
	return c.json({ connected: !!conn, ...conn })
})

const oauthProviders = new Set<OAuthProvider>([
	"github",
	"notion",
	"google_drive",
	"slack",
])

const allProviders = new Set<(typeof connections.$inferSelect)["provider"]>([
	"confluence",
	"figma",
	...oauthProviders,
	"mcp",
])

function connectionProvider(value: string) {
	return allProviders.has(
		value as (typeof connections.$inferSelect)["provider"],
	)
		? (value as (typeof connections.$inferSelect)["provider"])
		: null
}

function oauthProvider(value: string): OAuthProvider | null {
	return oauthProviders.has(value as OAuthProvider)
		? (value as OAuthProvider)
		: null
}

connectionsRoute.get("/:provider/start", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Organization owner access required" }, 403)
	}
	const provider = oauthProvider(c.req.param("provider"))
	if (!provider) return c.json({ error: "OAuth provider not found" }, 404)
	return c.redirect(
		connectorAuthorizeUrl(
			provider,
			encodeState({ orgId: caller.orgId, userId: caller.userId, provider }),
		),
	)
})

connectionsRoute.get(
	"/:provider/callback",
	zValidator("query", z.object({ code: z.string(), state: z.string() })),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const provider = oauthProvider(c.req.param("provider"))
		if (!provider) return c.json({ error: "OAuth provider not found" }, 404)
		const state = decodeState(c.req.valid("query").state)
		if (
			state.provider !== provider ||
			state.orgId !== caller.orgId ||
			state.userId !== caller.userId
		) {
			return c.json({ error: "OAuth state does not match this session" }, 403)
		}
		const token = await exchangeConnectorCode(
			provider,
			c.req.valid("query").code,
		)
		const [connection] = await db
			.insert(connections)
			.values({
				orgId: caller.orgId,
				createdBy: caller.userId,
				provider,
				providerAccountId: token.accountId,
				accessToken: encryptConnectionSecret(
					caller.orgId,
					provider,
					"access",
					token.accessToken,
				),
				refreshToken: encryptConnectionSecret(
					caller.orgId,
					provider,
					"refresh",
					token.refreshToken,
				),
				tokenExpiresAt: token.expiresAt,
				metadata: token.metadata,
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: token.accountId,
					createdBy: caller.userId,
					accessToken: encryptConnectionSecret(
						caller.orgId,
						provider,
						"access",
						token.accessToken,
					),
					refreshToken: encryptConnectionSecret(
						caller.orgId,
						provider,
						"refresh",
						token.refreshToken,
					),
					tokenExpiresAt: token.expiresAt,
					metadata: token.metadata,
				},
			})
			.returning({ id: connections.id, metadata: connections.metadata })
		return c.json({ connected: true, provider, connection })
	},
)

connectionsRoute.patch(
	"/github/config",
	zValidator(
		"json",
		z.object({
			repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(25),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const connection = await getConnectionRow(caller.orgId, "github")
		if (!connection) return c.json({ error: "GitHub is not connected" }, 404)
		const metadata = {
			...(connection.metadata ?? {}),
			repositories: [...new Set(c.req.valid("json").repositories)],
		}
		await updateConnectionMetadata(connection.id, metadata)
		return c.json({ metadata })
	},
)

connectionsRoute.post(
	"/mcp/connect",
	zValidator(
		"json",
		z.object({
			name: z.string().trim().min(1).max(120),
			baseUrl: z.string().url(),
			bearerToken: z.string().max(8_000).optional(),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const input = c.req.valid("json")
		const url = await assertPublicHttpUrl(input.baseUrl)
		const allowlist = new Set(
			(process.env.OUTBOUND_MCP_ALLOWLIST ?? "")
				.split(",")
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		)
		if (!allowlist.has(url.hostname.toLowerCase())) {
			return c.json({ error: "MCP host is not allowlisted" }, 403)
		}
		const [connection] = await db
			.insert(connections)
			.values({
				orgId: caller.orgId,
				createdBy: caller.userId,
				provider: "mcp",
				providerAccountId: url.origin,
				accessToken: encryptConnectionSecret(
					caller.orgId,
					"mcp",
					"access",
					input.bearerToken ?? "",
				),
				refreshToken: encryptConnectionSecret(
					caller.orgId,
					"mcp",
					"refresh",
					"",
				),
				metadata: { name: input.name, baseUrl: url.toString(), readOnly: true },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: url.origin,
					createdBy: caller.userId,
					accessToken: encryptConnectionSecret(
						caller.orgId,
						"mcp",
						"access",
						input.bearerToken ?? "",
					),
					metadata: {
						name: input.name,
						baseUrl: url.toString(),
						readOnly: true,
					},
				},
			})
			.returning({ id: connections.id, metadata: connections.metadata })
		return c.json({ connected: true, connection }, 201)
	},
)

connectionsRoute.post("/:provider/sync", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Organization owner access required" }, 403)
	}
	const provider = c.req.param("provider") as OAuthProvider | "mcp"
	if (![...oauthProviders, "mcp"].includes(provider)) {
		return c.json({ error: "Connector provider not found" }, 404)
	}
	const connection = await getConnectionRow(caller.orgId, provider)
	if (!connection) return c.json({ error: "Connector is not connected" }, 404)
	const job = await enqueueJob({
		orgId: caller.orgId,
		createdBy: caller.userId,
		type: "connector.sync",
		payload: { connectionId: connection.id },
		idempotencyKey: `${connection.id}:${Math.floor(Date.now() / 60_000)}`,
	})
	return c.json({ job }, 202)
})

connectionsRoute.patch(
	"/:provider/access",
	zValidator(
		"json",
		z.discriminatedUnion("scope", [
			z.object({ scope: z.literal("personal") }),
			z.object({ scope: z.literal("org") }),
			z.object({ scope: z.literal("team"), teamId: z.string().min(1) }),
		]),
	),
	async (c) => {
		const caller = await requireCaller(c)
		if (!canManageOrganization(caller.role)) {
			return c.json({ error: "Organization owner access required" }, 403)
		}
		const provider = connectionProvider(c.req.param("provider"))
		if (!provider) return c.json({ error: "Connector provider not found" }, 404)
		const input = c.req.valid("json")
		if (input.scope === "team") {
			const [organizationTeam] = await db
				.select({ id: team.id })
				.from(team)
				.where(
					and(eq(team.id, input.teamId), eq(team.organizationId, caller.orgId)),
				)
				.limit(1)
			if (!organizationTeam) return c.json({ error: "Team not found" }, 404)
		}
		const connection = await getConnectionRow(caller.orgId, provider)
		if (!connection) return c.json({ error: "Connector is not connected" }, 404)
		const access = {
			mapped: true,
			scope: input.scope,
			...(input.scope === "team" ? { teamId: input.teamId } : {}),
		}
		const metadata = { ...(connection.metadata ?? {}), access }
		const ownerUserId = connection.createdBy ?? caller.userId
		const principal =
			input.scope === "org"
				? { kind: "organization" as const, id: caller.orgId }
				: input.scope === "team"
					? { kind: "team" as const, id: input.teamId }
					: { kind: "user" as const, id: ownerUserId }
		await db.transaction(async (tx) => {
			await tx
				.update(connections)
				.set({ createdBy: ownerUserId, metadata })
				.where(eq(connections.id, connection.id))
			await tx
				.update(documents)
				.set({
					scope: input.scope,
					teamId: input.scope === "team" ? input.teamId : null,
					ownerUserId: input.scope === "personal" ? ownerUserId : null,
				})
				.where(eq(documents.connectionId, connection.id))
			await tx
				.update(sourceAccessGrants)
				.set({ principalKind: principal.kind, principalId: principal.id })
				.where(
					inArray(
						sourceAccessGrants.documentId,
						tx
							.select({ id: documents.id })
							.from(documents)
							.where(eq(documents.connectionId, connection.id)),
					),
				)
		})
		return c.json({ access })
	},
)

connectionsRoute.get("/:provider/status", async (c) => {
	const caller = await requireCaller(c)
	const provider = c.req.param("provider") as OAuthProvider | "mcp"
	if (![...oauthProviders, "mcp"].includes(provider)) {
		return c.json({ error: "Connector provider not found" }, 404)
	}
	const connection = await getConnectionRow(caller.orgId, provider)
	if (!connection) return c.json({ connected: false })
	const [health] = await db
		.select()
		.from(connectorCursors)
		.where(eq(connectorCursors.connectionId, connection.id))
		.limit(1)
	return c.json({ connected: true, ...connection, health: health ?? null })
})

connectionsRoute.delete("/:provider", async (c) => {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		return c.json({ error: "Organization owner access required" }, 403)
	}
	const provider = connectionProvider(c.req.param("provider"))
	if (!provider) return c.json({ error: "Connector provider not found" }, 404)
	const connection = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({
				id: connections.id,
				accessToken: connections.accessToken,
				refreshToken: connections.refreshToken,
			})
			.from(connections)
			.where(
				and(
					eq(connections.orgId, caller.orgId),
					eq(connections.provider, provider),
				),
			)
			.limit(1)
		if (!existing) return null
		await tx.delete(documents).where(eq(documents.connectionId, existing.id))
		await tx.delete(connections).where(eq(connections.id, existing.id))
		return existing
	})
	if (!connection) return c.json({ error: "Connector not found" }, 404)
	deleteSecret(connection.accessToken)
	deleteSecret(connection.refreshToken)
	return c.json({ disconnected: true })
})
