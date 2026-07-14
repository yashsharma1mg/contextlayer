import { zValidator } from "@hono/zod-validator"
import { connections, db } from "@repo/db"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
	exchangeCodeForToken,
	getAccessibleSites,
	getAuthorizeUrl,
} from "../lib/confluence"
import { syncConfluenceConnection } from "../lib/confluence-sync"
import { updateConnectionMetadata } from "../lib/connections"
import {
	exchangeCodeForToken as exchangeFigmaCode,
	getAuthorizeUrl as getFigmaAuthorizeUrl,
	getCurrentUser as getFigmaCurrentUser,
	parseFileKey,
} from "../lib/figma"
import { syncAllWatchedFiles, syncFigmaFile } from "../lib/figma-sync"
import { requireCaller } from "../lib/caller"
import { encryptSecret } from "../lib/secrets"

export const connectionsRoute = new Hono()

type OAuthState = {
	orgId: string
	userId: string
	provider: "confluence" | "figma"
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
	provider: "confluence" | "figma",
) {
	const [conn] = await db
		.select({
			id: connections.id,
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
				provider: "confluence",
				providerAccountId: site.id,
				accessToken: encryptSecret(token.access_token),
				refreshToken: encryptSecret(token.refresh_token),
				tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				metadata: { cloudId: site.id, siteUrl: site.url },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: site.id,
					accessToken: encryptSecret(token.access_token),
					refreshToken: encryptSecret(token.refresh_token),
					tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
					metadata: { cloudId: site.id, siteUrl: site.url },
				},
			})

		return c.json({ connected: true, site: site.url })
	},
)

connectionsRoute.post("/confluence/sync", async (c) => {
	const caller = await requireCaller(c)
	return c.json(await syncConfluenceConnection(caller.orgId))
})

connectionsRoute.get("/confluence/status", async (c) => {
	const caller = await requireCaller(c)
	const conn = await getConnectionRow(caller.orgId, "confluence")
	return c.json({ connected: !!conn, ...conn })
})

// --- Figma ---

connectionsRoute.get("/figma/start", async (c) => {
	const caller = await requireCaller(c)
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
				provider: "figma",
				providerAccountId: user.id,
				accessToken: encryptSecret(token.access_token),
				refreshToken: encryptSecret(token.refresh_token),
				tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				metadata: { handle: user.handle, watchedFileKeys: [] },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: user.id,
					accessToken: encryptSecret(token.access_token),
					refreshToken: encryptSecret(token.refresh_token),
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
		const { fileKey } = c.req.valid("json")
		const orgId = caller.orgId
		if (fileKey) return c.json(await syncFigmaFile(orgId, fileKey))
		return c.json({ files: await syncAllWatchedFiles(orgId) })
	},
)

connectionsRoute.get("/figma/status", async (c) => {
	const caller = await requireCaller(c)
	const conn = await getConnectionRow(caller.orgId, "figma")
	return c.json({ connected: !!conn, ...conn })
})
