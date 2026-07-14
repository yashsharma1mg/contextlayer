import {
	backgroundJobs,
	connections,
	connectorCursors,
	db,
	migrateDatabase,
} from "@repo/db"
import { count, eq, isNotNull } from "drizzle-orm"
import { statfs } from "node:fs/promises"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
import {
	enqueueJob,
	registerJobHandler,
	startJobWorker,
} from "./lib/background-jobs"
import { syncConfluenceConnection } from "./lib/confluence-sync"
import { syncAllWatchedFiles, syncFigmaFile } from "./lib/figma-sync"
import { syncExternalConnection } from "./lib/connector-sync"
import {
	ingestCapture,
	markCaptureIngestionFailed,
} from "./lib/capture-ingestion"
import { migrateConnectionSecretsToKeychain } from "./lib/connections"
import { processDesignImport } from "./lib/design-import"
import { ingestStoredObject, ingestUrl } from "./lib/ingestion-jobs"
import { publishArtifactToGitHub } from "./lib/publish-github"
import { assertConnectionEncryptionConfigured } from "./lib/secrets"
import { askRoute } from "./routes/ask"
import { canvasRoute } from "./routes/canvas"
import { captureImportRoute } from "./routes/capture-import"
import { connectionsRoute } from "./routes/connections"
import { designSystemsRoute } from "./routes/design-systems"
import { ideasRoute } from "./routes/ideas"
import { jobsRoute } from "./routes/jobs"
import {
	mcpRoute,
	mcpTokensRoute,
	protectedResourceMetadata,
} from "./routes/mcp"
import { memoriesRoute } from "./routes/memories"
import { privacyRoute } from "./routes/privacy"
import { publicationRoute } from "./routes/publication"

const app = new Hono()

assertConnectionEncryptionConfigured()

if (process.env.AUTO_MIGRATE === "true") {
	const migrationsFolder = process.env.MIGRATIONS_DIR
	if (!migrationsFolder) throw new Error("MIGRATIONS_DIR is required")
	await migrateDatabase(migrationsFolder)
}

await migrateConnectionSecretsToKeychain()

app.use(
	"*",
	cors({
		origin: process.env.STUDIO_URL ?? "http://localhost:3000",
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
)

app.get("/health", (c) => c.json({ ok: true }))
app.get("/health/desktop", async (c) => {
	await db.execute("select 1")
	const [queue, failedConnectors, storage] = await Promise.all([
		db
			.select({ status: backgroundJobs.status, count: count() })
			.from(backgroundJobs)
			.groupBy(backgroundJobs.status),
		db
			.select({ count: count() })
			.from(connectorCursors)
			.where(isNotNull(connectorCursors.lastError)),
		statfs(process.env.CONTEXT_LAYER_DATA_DIR ?? process.cwd()),
	])
	const memory = process.memoryUsage()
	return c.json({
		ok: true,
		sidecars: { agent: "ready", database: "ready" },
		migrations: "ready",
		storage: {
			path: process.env.CONTEXT_LAYER_DATA_DIR ?? process.cwd(),
			availableBytes: storage.bavail * storage.bsize,
		},
		queue: Object.fromEntries(queue.map((row) => [row.status, row.count])),
		connectors: { failed: failedConnectors[0]?.count ?? 0 },
		resources: {
			uptimeSeconds: Math.round(process.uptime()),
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
		},
	})
})

const oauthServerMetadata = oauthProviderAuthServerMetadata(auth)
const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth)
app.get("/.well-known/oauth-authorization-server", (c) =>
	oauthServerMetadata(c.req.raw),
)
app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
	oauthServerMetadata(c.req.raw),
)
app.get("/.well-known/openid-configuration", (c) => openIdMetadata(c.req.raw))
app.get("/.well-known/oauth-protected-resource", async (c) =>
	c.json(await protectedResourceMetadata()),
)
app.get("/.well-known/oauth-protected-resource/mcp", async (c) =>
	c.json(await protectedResourceMetadata()),
)

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))

app.route("/api/memories", memoriesRoute)
app.route("/api/ask", askRoute)
app.route("/api/connections", connectionsRoute)
app.route("/api", ideasRoute)
app.route("/api", canvasRoute)
app.route("/api/capture", captureImportRoute)
app.route("/api", designSystemsRoute)
app.route("/api/mcp", mcpTokensRoute)
app.route("/api/jobs", jobsRoute)
app.route("/api/privacy", privacyRoute)
app.route("/api", publicationRoute)
app.route("/mcp", mcpRoute)

// Neither Confluence (3LO apps get no webhooks) nor this Figma integration
// (no push mechanism used) support push updates, so periodic polling is the
// only way to pick up changes — a setInterval is the minimal viable
// scheduler for a long-running process; revisit if this ever moves to a
// request-scoped runtime (e.g. Cloudflare Workers) where this won't fire.
const POLL_INTERVAL_MS =
	(Number(process.env.CONNECTOR_POLL_MINUTES) || 15) * 60_000
async function orgsByProvider(provider: "confluence" | "figma") {
	const rows = await db
		.selectDistinct({ orgId: connections.orgId })
		.from(connections)
		.where(eq(connections.provider, provider))
	return rows.map((r) => r.orgId)
}

registerJobHandler("connector.confluence", async (payload, context) => {
	const orgId = String(payload.orgId ?? "")
	if (!orgId) throw new Error("Confluence sync is missing orgId")
	await context.progress(10)
	await syncConfluenceConnection(orgId, context.signal)
	return { provider: "confluence", orgId }
})

registerJobHandler("connector.figma", async (payload, context) => {
	const orgId = String(payload.orgId ?? "")
	if (!orgId) throw new Error("Figma sync is missing orgId")
	await context.progress(10)
	const fileKey = typeof payload.fileKey === "string" ? payload.fileKey : null
	if (fileKey) await syncFigmaFile(orgId, fileKey, context.signal)
	else await syncAllWatchedFiles(orgId, context.signal)
	return { provider: "figma", orgId }
})

registerJobHandler("connector.sync", async (payload, context) => {
	const connectionId = String(payload.connectionId ?? "")
	if (!connectionId) throw new Error("Connector sync is missing connectionId")
	await context.progress(5)
	return syncExternalConnection(connectionId, context.signal)
})

registerJobHandler("design.import", async (payload, context) => {
	const runId = String(payload.runId ?? "")
	if (!runId) throw new Error("Design import is missing runId")
	await context.progress(5)
	const result = await processDesignImport(runId)
	await context.progress(95)
	return result
})

registerJobHandler("ingest.object", async (payload, context) =>
	ingestStoredObject(payload, context.progress, context.signal),
)

registerJobHandler("ingest.url", async (payload, context) =>
	ingestUrl(payload, context.progress, context.signal),
)

registerJobHandler("capture.ingest", async (payload, context) => {
	try {
		return await ingestCapture(payload, context.progress)
	} catch (error) {
		await markCaptureIngestionFailed(payload, error)
		throw error
	}
})

registerJobHandler("github.publish", async (payload, context) => {
	const auditId = String(payload.auditId ?? "")
	if (!auditId) throw new Error("GitHub publication is missing auditId")
	await context.progress(5)
	const result = await publishArtifactToGitHub(auditId)
	await context.progress(95)
	return result
})

async function pollConnectors() {
	try {
		for (const orgId of await orgsByProvider("confluence")) {
			await enqueueJob({
				orgId,
				createdBy: "system",
				type: "connector.confluence",
				payload: { orgId },
				idempotencyKey: `${orgId}:${Math.floor(Date.now() / POLL_INTERVAL_MS)}`,
			})
		}

		for (const orgId of await orgsByProvider("figma")) {
			await enqueueJob({
				orgId,
				createdBy: "system",
				type: "connector.figma",
				payload: { orgId },
				idempotencyKey: `${orgId}:${Math.floor(Date.now() / POLL_INTERVAL_MS)}`,
			})
		}
	} catch (e) {
		console.error("Connector scheduling failed:", e)
	}
}

const stopJobWorker =
	process.env.BACKGROUND_WORKER !== "false" ? startJobWorker() : () => undefined

if (process.env.CONNECTOR_POLLING === "true") {
	const connectorTimer = setInterval(pollConnectors, POLL_INTERVAL_MS)
	connectorTimer.unref?.()
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		stopJobWorker()
		process.exit(0)
	})
}

export default {
	port: process.env.PORT ? Number(process.env.PORT) : 8787,
	hostname: process.env.HOSTNAME ?? "127.0.0.1",
	fetch: app.fetch,
}
