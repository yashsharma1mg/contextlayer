import { connections, db } from "@repo/db"
import { and, eq } from "drizzle-orm"
import { refreshAccessToken as refreshConfluenceToken } from "./confluence"
import { refreshAccessToken as refreshFigmaToken } from "./figma"
import { decryptSecret, encryptConnectionSecret } from "./secrets"
import { refreshConnectorToken, type OAuthProvider } from "./connector-oauth"

export type Connection = typeof connections.$inferSelect
export type ConnectionProvider = Connection["provider"]

export function connectionIngestScope(conn: Connection) {
	const access = (conn.metadata as { access?: Record<string, unknown> } | null)
		?.access
	if (access?.mapped === true && access.scope === "org") {
		return {
			scope: "org" as const,
			createdBy: conn.createdBy ?? undefined,
			consentUserId: conn.createdBy ?? undefined,
		}
	}
	if (
		access?.mapped === true &&
		access.scope === "team" &&
		typeof access.teamId === "string"
	) {
		return {
			scope: "team" as const,
			teamId: access.teamId,
			createdBy: conn.createdBy ?? undefined,
			consentUserId: conn.createdBy ?? undefined,
		}
	}
	if (conn.createdBy) {
		return {
			scope: "personal" as const,
			ownerUserId: conn.createdBy,
			createdBy: conn.createdBy,
			consentUserId: conn.createdBy,
		}
	}
	throw new Error(
		"Connector access principals are not mapped; reconnect it first",
	)
}

export async function getDecryptedConnection(
	orgId: string,
	provider: ConnectionProvider,
) {
	const [conn] = await db
		.select()
		.from(connections)
		.where(
			and(eq(connections.orgId, orgId), eq(connections.provider, provider)),
		)
	if (!conn) return null
	return {
		...conn,
		accessToken: decryptSecret(conn.accessToken),
		refreshToken: decryptSecret(conn.refreshToken),
	}
}

const isExpiring = (conn: Connection) =>
	!!conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() <= Date.now() + 60_000

/** Confluence's refresh response includes a fresh refresh_token — persist it. */
export async function getValidConfluenceConnection(
	orgId: string,
): Promise<Connection | null> {
	const conn = await getDecryptedConnection(orgId, "confluence")
	if (!conn || !isExpiring(conn)) return conn

	const refreshed = await refreshConfluenceToken(conn.refreshToken)
	const [updated] = await db
		.update(connections)
		.set({
			accessToken: encryptConnectionSecret(
				orgId,
				"confluence",
				"access",
				refreshed.access_token,
			),
			refreshToken: encryptConnectionSecret(
				orgId,
				"confluence",
				"refresh",
				refreshed.refresh_token,
			),
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
	const conn = await getDecryptedConnection(orgId, "figma")
	if (!conn || !isExpiring(conn)) return conn

	const refreshed = await refreshFigmaToken(conn.refreshToken)
	const [updated] = await db
		.update(connections)
		.set({
			accessToken: encryptConnectionSecret(
				orgId,
				"figma",
				"access",
				refreshed.access_token,
			),
			tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
		})
		.where(eq(connections.id, conn.id))
		.returning()
	return updated ?? null
}

const externalOAuthProviders = new Set<OAuthProvider>([
	"github",
	"notion",
	"google_drive",
	"slack",
])

export async function getValidExternalConnection(
	orgId: string,
	provider: ConnectionProvider,
): Promise<Connection | null> {
	const conn = await getDecryptedConnection(orgId, provider)
	if (!conn || !isExpiring(conn)) return conn
	if (!externalOAuthProviders.has(provider as OAuthProvider)) return conn

	const refreshed = await refreshConnectorToken(
		provider as OAuthProvider,
		conn.refreshToken,
	)
	const [updated] = await db
		.update(connections)
		.set({
			accessToken: encryptConnectionSecret(
				orgId,
				provider,
				"access",
				refreshed.accessToken,
			),
			refreshToken: encryptConnectionSecret(
				orgId,
				provider,
				"refresh",
				refreshed.refreshToken ?? conn.refreshToken,
			),
			tokenExpiresAt: refreshed.expiresAt,
		})
		.where(eq(connections.id, conn.id))
		.returning()
	return updated
		? {
				...updated,
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken ?? conn.refreshToken,
			}
		: null
}

export async function migrateConnectionSecretsToKeychain() {
	if (!process.env.CONTEXT_LAYER_KEYCHAIN_SERVICE) return
	const rows = await db.select().from(connections)
	for (const connection of rows) {
		if (
			connection.accessToken.startsWith("keychain:v1:") &&
			(connection.refreshToken.startsWith("keychain:v1:") ||
				!decryptSecret(connection.refreshToken))
		)
			continue
		await db
			.update(connections)
			.set({
				accessToken: encryptConnectionSecret(
					connection.orgId,
					connection.provider,
					"access",
					decryptSecret(connection.accessToken),
				),
				refreshToken: encryptConnectionSecret(
					connection.orgId,
					connection.provider,
					"refresh",
					decryptSecret(connection.refreshToken),
				),
			})
			.where(eq(connections.id, connection.id))
	}
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
