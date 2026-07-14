import { connections, db } from "@repo/db"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { syncConfluenceConnection } from "./lib/confluence-sync"
import { syncAllWatchedFiles } from "./lib/figma-sync"
import { assertConnectionEncryptionConfigured } from "./lib/secrets"
import { askRoute } from "./routes/ask"
import { canvasRoute } from "./routes/canvas"
import { captureImportRoute } from "./routes/capture-import"
import { connectionsRoute } from "./routes/connections"
import { designSystemsRoute } from "./routes/design-systems"
import { ideasRoute } from "./routes/ideas"
import { mcpRoute, mcpTokensRoute } from "./routes/mcp"
import { memoriesRoute } from "./routes/memories"

const app = new Hono()

assertConnectionEncryptionConfigured()

app.use(
	"*",
	cors({
		origin: process.env.STUDIO_URL ?? "http://localhost:3000",
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
	}),
)

app.get("/health", (c) => c.json({ ok: true }))

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))

app.route("/api/memories", memoriesRoute)
app.route("/api/ask", askRoute)
app.route("/api/connections", connectionsRoute)
app.route("/api", ideasRoute)
app.route("/api", canvasRoute)
app.route("/api/capture", captureImportRoute)
app.route("/api", designSystemsRoute)
app.route("/api/mcp", mcpTokensRoute)
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

let polling = false

async function pollConnectors() {
	if (polling) return
	polling = true
	// The whole callback needs to be crash-proof, not just the per-org loop
	// bodies — a dropped pooled connection on the "list orgs" query itself
	// (observed against Supabase's free-tier pooler after idle time) was an
	// unhandled rejection that took the entire server down, not just that
	// poll cycle.
	try {
		for (const orgId of await orgsByProvider("confluence")) {
			try {
				await syncConfluenceConnection(orgId)
			} catch (e) {
				console.error(`Confluence sync failed for org ${orgId}:`, e)
			}
		}

		for (const orgId of await orgsByProvider("figma")) {
			try {
				await syncAllWatchedFiles(orgId)
			} catch (e) {
				console.error(`Figma sync failed for org ${orgId}:`, e)
			}
		}
	} catch (e) {
		console.error("Connector poll cycle failed:", e)
	} finally {
		polling = false
	}
}

if (
	process.env.NODE_ENV === "production" ||
	process.env.CONNECTOR_POLLING === "true"
) {
	setInterval(pollConnectors, POLL_INTERVAL_MS)
}

export default {
	port: process.env.PORT ? Number(process.env.PORT) : 8787,
	fetch: app.fetch,
}
