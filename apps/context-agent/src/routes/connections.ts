import { zValidator } from "@hono/zod-validator"
import { connections, db } from "@repo/db"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
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

export const connectionsRoute = new Hono()

const encodeState = (orgId: string) =>
	Buffer.from(JSON.stringify({ orgId })).toString("base64url")
const decodeState = (state: string) =>
	JSON.parse(Buffer.from(state, "base64url").toString()) as { orgId: string }

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

connectionsRoute.get(
	"/confluence/start",
	zValidator("query", z.object({ orgId: z.string() })),
	(c) => c.redirect(getAuthorizeUrl(encodeState(c.req.valid("query").orgId))),
)

connectionsRoute.get(
	"/confluence/callback",
	zValidator("query", z.object({ code: z.string(), state: z.string() })),
	async (c) => {
		const { code, state } = c.req.valid("query")
		const { orgId } = decodeState(state)

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
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				metadata: { cloudId: site.id, siteUrl: site.url },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: site.id,
					accessToken: token.access_token,
					refreshToken: token.refresh_token,
					tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
					metadata: { cloudId: site.id, siteUrl: site.url },
				},
			})

		return c.json({ connected: true, site: site.url })
	},
)

connectionsRoute.post(
	"/confluence/sync",
	zValidator("json", z.object({ orgId: z.string() })),
	async (c) =>
		c.json(await syncConfluenceConnection(c.req.valid("json").orgId)),
)

connectionsRoute.get(
	"/confluence/status",
	zValidator("query", z.object({ orgId: z.string() })),
	async (c) => {
		const conn = await getConnectionRow(
			c.req.valid("query").orgId,
			"confluence",
		)
		return c.json({ connected: !!conn, ...conn })
	},
)

// --- Figma ---

connectionsRoute.get(
	"/figma/start",
	zValidator("query", z.object({ orgId: z.string() })),
	(c) =>
		c.redirect(getFigmaAuthorizeUrl(encodeState(c.req.valid("query").orgId))),
)

connectionsRoute.get(
	"/figma/callback",
	zValidator("query", z.object({ code: z.string(), state: z.string() })),
	async (c) => {
		const { code, state } = c.req.valid("query")
		const { orgId } = decodeState(state)

		const token = await exchangeFigmaCode(code)
		const user = await getFigmaCurrentUser(token.access_token)

		await db
			.insert(connections)
			.values({
				orgId,
				provider: "figma",
				providerAccountId: user.id,
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
				metadata: { handle: user.handle, watchedFileKeys: [] },
			})
			.onConflictDoUpdate({
				target: [connections.orgId, connections.provider],
				set: {
					providerAccountId: user.id,
					accessToken: token.access_token,
					refreshToken: token.refresh_token,
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
	zValidator("json", z.object({ orgId: z.string(), fileUrl: z.string() })),
	async (c) => {
		const { orgId, fileUrl } = c.req.valid("json")
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
	zValidator(
		"json",
		z.object({ orgId: z.string(), fileKey: z.string().optional() }),
	),
	async (c) => {
		const { orgId, fileKey } = c.req.valid("json")
		if (fileKey) return c.json(await syncFigmaFile(orgId, fileKey))
		return c.json({ files: await syncAllWatchedFiles(orgId) })
	},
)

connectionsRoute.get(
	"/figma/status",
	zValidator("query", z.object({ orgId: z.string() })),
	async (c) => {
		const conn = await getConnectionRow(c.req.valid("query").orgId, "figma")
		return c.json({ connected: !!conn, ...conn })
	},
)
