"use client"

import { use, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { authClient, useSession } from "@/lib/auth-client"

/** Accept-invitation landing page — the link an inviter copies and shares. */
export default function InvitePage({
	params,
}: {
	params: Promise<{ id: string }>
}) {
	const { id: invitationId } = use(params)
	const router = useRouter()
	const { data: session, isPending } = useSession()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function handleAccept() {
		setBusy(true)
		setError(null)
		const { error: err } = await authClient.organization.acceptInvitation({
			invitationId,
		})
		setBusy(false)
		if (err) {
			setError(err.message ?? "Could not accept invitation")
			return
		}
		router.push("/projects")
	}

	if (isPending) {
		return <div className="p-8 text-sm text-muted-foreground">Loading...</div>
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<div className="w-full max-w-sm space-y-4 rounded-[var(--radius-lg)] border border-border bg-card p-6 text-center">
				<h1 className="text-lg font-medium text-foreground">Join the team</h1>
				{session ? (
					<>
						<p className="text-sm text-muted-foreground">
							Accept this invitation as {session.user.email}?
						</p>
						<Button onClick={handleAccept} disabled={busy} className="w-full">
							{busy ? "..." : "Accept invitation"}
						</Button>
					</>
				) : (
					<>
						<p className="text-sm text-muted-foreground">
							Sign in first, then reopen this link.
						</p>
						<Button onClick={() => router.push("/login")} className="w-full">
							Sign in
						</Button>
					</>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
			</div>
		</div>
	)
}
