"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiGet, apiSend } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { useCaller } from "@/lib/use-caller"

interface Project {
	id: string
	name: string
	visibility: "personal" | "team" | "org"
	ownerUserId: string
	updatedAt: string
}

export default function ProjectsPage() {
	const { caller, pending, orgName } = useCaller()
	const [projects, setProjects] = useState<Project[]>([])
	const [name, setName] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [inviteEmail, setInviteEmail] = useState("")
	const [inviteLink, setInviteLink] = useState<string | null>(null)
	const [inviting, setInviting] = useState(false)

	const load = useCallback(async () => {
		if (!caller) return
		const data = await apiGet<{ projects: Project[] }>("/api/projects")
		setProjects(data.projects)
	}, [caller])

	useEffect(() => {
		load().catch((e) => setError(e.message))
	}, [load])

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault()
		if (!caller) return
		setBusy(true)
		setError(null)
		try {
			await apiSend("POST", "/api/projects", { name })
			setName("")
			await load()
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to create project")
		} finally {
			setBusy(false)
		}
	}

	async function handleInvite(e: React.FormEvent) {
		e.preventDefault()
		setInviting(true)
		setError(null)
		setInviteLink(null)
		const { data, error: err } = await authClient.organization.inviteMember({
			email: inviteEmail,
			role: "member",
		})
		setInviting(false)
		if (err || !data) {
			setError(err?.message ?? "Invite failed")
			return
		}
		// No email delivery wired yet — surface the accept link to copy/share.
		setInviteLink(`${window.location.origin}/invite/${data.id}`)
		setInviteEmail("")
	}

	if (pending || !caller) {
		return <div className="p-8 text-sm text-muted-foreground">Loading...</div>
	}

	return (
		<div className="mx-auto min-h-screen max-w-2xl px-4 py-12">
			<div className="mb-6 flex items-baseline justify-between">
				<div>
					<h1 className="text-lg font-medium text-foreground">Projects</h1>
					<p className="text-sm text-muted-foreground">{orgName}</p>
				</div>
				<Link
					href="/"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					Knowledge base →
				</Link>
			</div>

			<form onSubmit={handleCreate} className="mb-8 flex gap-2">
				<Input
					placeholder="New project name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
				/>
				<Button type="submit" disabled={busy}>
					{busy ? "..." : "Create"}
				</Button>
			</form>

			{error && <p className="mb-4 text-sm text-destructive">{error}</p>}

			<form onSubmit={handleInvite} className="mb-8 flex gap-2">
				<Input
					type="email"
					placeholder="Invite a teammate by email"
					value={inviteEmail}
					onChange={(e) => setInviteEmail(e.target.value)}
					required
				/>
				<Button type="submit" variant="outline" disabled={inviting}>
					{inviting ? "..." : "Invite"}
				</Button>
			</form>
			{inviteLink && (
				<p className="mb-8 break-all rounded-[var(--radius-md)] border border-border bg-card p-3 text-xs text-muted-foreground">
					Share this link with them:{" "}
					<span className="text-foreground">{inviteLink}</span>
				</p>
			)}

			<div className="space-y-2">
				{projects.map((p) => (
					<Link
						key={p.id}
						href={`/projects/${p.id}`}
						className="flex items-center justify-between rounded-[var(--radius-lg)] border border-border bg-card p-4 hover:bg-muted"
					>
						<span className="text-sm font-medium text-foreground">
							{p.name}
						</span>
						<span className="text-xs text-muted-foreground">
							{p.visibility}
						</span>
					</Link>
				))}
				{projects.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No projects yet — create one above to start ideating.
					</p>
				)}
			</div>
		</div>
	)
}
