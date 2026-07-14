import { connections, db } from "@repo/db"
import { and, eq } from "drizzle-orm"
import { refreshAccessToken as refreshConfluenceToken } from "./confluence"
import { refreshAccessToken as refreshFigmaToken } from "./figma"

type Connection = typeof connections.$inferSelect

async function getConnection(orgId: string, provider: "confluence" | "figma") {
	const [conn] = await db
		.select()
		.from(connections)
		.where(
			and(eq(connections.orgId, orgId), eq(connections.provider, provider)),
		)
	return conn ?? null
}

const isExpiring = (conn: Connection) =>
	!!conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() <= Date.now() + 60_000

/** Confluence's refresh response includes a fresh refresh_token — persist it. */
export async function getValidConfluenceConnection(
	orgId: string,
): Promise<Connection | null> {
	const conn = await getConnection(orgId, "confluence")
	if (!conn || !isExpiring(conn)) return conn

	const refreshed = await refreshConfluenceToken(conn.refreshToken)
	const [updated] = await db
		.update(connections)
		.set({
			accessToken: refreshed.access_token,
			refreshToken: refreshed.refresh_token,
			tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
		})
		.where(eq(connections.id, conn.id))
		.returning()
	return updated ?? null
}

/** Figma's refresh does NOT return a new refresh_token — the original stays valid, don't overwrite it. */
export async function getValidFigmaConnection(
	orgId: string,
): Promise<Connection | null> {
	const conn = await getConnection(orgId, "figma")
	if (!conn || !isExpiring(conn)) return conn

	const refreshed = await refreshFigmaToken(conn.refreshToken)
	const [updated] = await db
		.update(connections)
		.set({
			accessToken: refreshed.access_token,
			tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
		})
		.where(eq(connections.id, conn.id))
		.returning()
	return updated ?? null
}

export async function updateConnectionMetadata(
	connectionId: string,
	metadata: Record<string, unknown>,
) {
	await db
		.update(connections)
		.set({ metadata })
		.where(eq(connections.id, connectionId))
}
