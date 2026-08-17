"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authClient, useSession } from "@/lib/auth-client"

/**
 * Onboarding gate. Organization creation lives here and nowhere else, so this
 * route has to stay reachable for a signed-in user without an org. Once one
 * exists there is nothing to do here and the canvas is the real destination.
 */
export default function HomePage() {
	const router = useRouter()
	const { data: session, isPending: sessionPending } = useSession()
	const { data: activeOrg, isPending: orgPending } =
		authClient.useActiveOrganization()

	const [orgName, setOrgName] = useState("")
	const [creatingOrg, setCreatingOrg] = useState(false)

	useEffect(() => {
		if (!sessionPending && !session) router.replace("/login")
	}, [sessionPending, session, router])

	useEffect(() => {
		if (!orgPending && activeOrg) router.replace("/projects")
	}, [orgPending, activeOrg, router])

	async function handleCreateOrg(e: React.FormEvent) {
		e.preventDefault()
		setCreatingOrg(true)
		const slug = orgName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "")
		await authClient.organization.create({ name: orgName, slug })
		setCreatingOrg(false)
	}

	if (sessionPending || orgPending) {
		return <div className="p-8 text-sm text-muted-foreground">Loading...</div>
	}
	if (!session || activeOrg) return null

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<form
				onSubmit={handleCreateOrg}
				className="w-full max-w-sm space-y-4 rounded-[var(--radius-lg)] border border-border bg-card p-6"
			>
				<h1 className="text-lg font-medium text-foreground">
					Create your organization
				</h1>
				<Input
					placeholder="Organization name"
					value={orgName}
					onChange={(e) => setOrgName(e.target.value)}
					required
				/>
				<Button type="submit" disabled={creatingOrg} className="w-full">
					{creatingOrg ? "..." : "Create"}
				</Button>
			</form>
		</div>
	)
}
