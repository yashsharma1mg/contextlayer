import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL is not set")
}

// Supabase's transaction-mode pooler (Supavisor) closes idle connections
// server-side; without a client-side idle_timeout shorter than that, the
// next query on a stale connection fails outright (seen as both a
// transient "password authentication failed" and a hard CONNECTION_CLOSED
// crash). Recycling proactively client-side avoids both.
const client = postgres(process.env.DATABASE_URL, {
	idle_timeout: 20,
	max_lifetime: 60 * 30,
})
export const db = drizzle(client, { schema })

export * from "./schema"
