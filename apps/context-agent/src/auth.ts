import { db } from "@repo/db"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { jwt, organization } from "better-auth/plugins"
import { oauthProvider } from "@better-auth/oauth-provider"

export const mcpScopes = [
	"knowledge:read",
	"canvas:read",
	"design:read",
	"artifacts:write",
	"generation:write",
	"publication:write",
] as const

const studioUrl = process.env.STUDIO_URL ?? "http://localhost:3000"
const authUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:8787"

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
		jwt(),
		oauthProvider({
			loginPage: `${studioUrl}/login`,
			consentPage: `${studioUrl}/consent`,
			scopes: ["openid", "profile", "offline_access", ...mcpScopes],
			validAudiences: [`${authUrl}/mcp`],
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			clientRegistrationDefaultScopes: [
				"openid",
				"profile",
				"knowledge:read",
				"canvas:read",
				"design:read",
			],
			clientRegistrationAllowedScopes: [
				"openid",
				"profile",
				"offline_access",
				...mcpScopes,
			],
			clientReference: ({ session }) =>
				typeof session?.activeOrganizationId === "string"
					? session.activeOrganizationId
					: undefined,
			postLogin: {
				page: `${studioUrl}/consent`,
				shouldRedirect: async () => false,
				consentReferenceId: ({ session }) =>
					typeof session.activeOrganizationId === "string"
						? session.activeOrganizationId
						: undefined,
			},
			customAccessTokenClaims: ({ referenceId }) => ({
				org_id: referenceId,
			}),
		}),
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
