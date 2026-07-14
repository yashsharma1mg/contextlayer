import { connections, db } from "@repo/db"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { auth } from "./auth"
import { syncConfluenceConnection } from "./lib/confluence-sync"
import { syncAllWatchedFiles } from "./lib/figma-sync"
import { askRoute } from "./routes/ask"
import { connectionsRoute } from "./routes/connections"
import { ideasRoute } from "./routes/ideas"
import { memoriesRoute } from "./routes/memories"

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true }))

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))

app.route("/api/memories", memoriesRoute)
app.route("/api/ask", askRoute)
app.route("/api/connections", connectionsRoute)
app.route("/api", ideasRoute)

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

setInterval(async () => {
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
	}
}, POLL_INTERVAL_MS)

export default {
	port: process.env.PORT ? Number(process.env.PORT) : 8787,
	fetch: app.fetch,
}
