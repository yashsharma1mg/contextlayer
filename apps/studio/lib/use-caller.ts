"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { authClient, useSession } from "@/lib/auth-client"
import type { Caller } from "@/lib/api"

/**
 * Session + active-org identity for API calls, with redirect-to-login.
 * teamIds is empty for now — team membership isn't surfaced client-side
 * yet, so team-shared projects only appear once that's wired up.
 */
export function useCaller(): {
	caller: Caller | null
	pending: boolean
	orgName: string | null
} {
	const router = useRouter()
	const { data: session, isPending: sessionPending } = useSession()
	const { data: activeOrg, isPending: orgPending } =
		authClient.useActiveOrganization()

	useEffect(() => {
		if (!sessionPending && !session) router.push("/login")
	}, [sessionPending, session, router])

	const pending = sessionPending || orgPending
	if (pending || !session || !activeOrg) {
		return { caller: null, pending, orgName: null }
	}
	return {
		caller: { orgId: activeOrg.id, userId: session.user.id, teamIds: [] },
		pending: false,
		orgName: activeOrg.name,
	}
}
