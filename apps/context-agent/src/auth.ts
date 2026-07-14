import { db } from "@repo/db"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"

/**
 * Org/team identity layer. This gives us membership + roles
 * ("is user X an admin of team Y") — NOT per-document permissions.
 * Per-document read/edit is enforced separately via the
 * `documentAcl` table in @repo/db (see packages/db/src/schema/memory.ts).
 */
export const auth = betterAuth({
	trustedOrigins: [
		process.env.STUDIO_URL ?? "http://localhost:3000",
		...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? []),
	],
	database: drizzleAdapter(db, { provider: "pg" }),
	emailAndPassword: {
		enabled: true,
	},
	plugins: [
		organization({
			teams: {
				enabled: true,
				maximumTeams: 50,
				allowRemovingAllTeams: false,
			},
		}),
	],
})

export type Auth = typeof auth
