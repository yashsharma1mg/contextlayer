import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { API_URL } from "./api"

// Matches the plugins actually enabled in apps/context-agent/src/auth.ts —
// no magic link / OTP / anonymous / admin, those aren't wired up server-side.
export const authClient = createAuthClient({
	baseURL: API_URL,
	plugins: [organizationClient(), oauthProviderClient()],
})

export const { signIn, signUp, signOut, useSession } = authClient
