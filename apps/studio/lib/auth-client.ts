import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

// Matches the plugins actually enabled in apps/context-agent/src/auth.ts —
// no magic link / OTP / anonymous / admin, those aren't wired up server-side.
export const authClient = createAuthClient({
	baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787",
	plugins: [organizationClient()],
})

export const { signIn, signUp, signOut, useSession } = authClient
