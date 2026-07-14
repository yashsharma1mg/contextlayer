"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authClient, useSession } from "@/lib/auth-client"

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"

interface Source {
	documentId: string
	title: string
	url: string | null
	source: string
	scope: string
	chunkContent: string
}

export default function ConsolePage() {
	const router = useRouter()
	const { data: session, isPending: sessionPending } = useSession()
	const { data: activeOrg, isPending: orgPending } =
		authClient.useActiveOrganization()

	const [orgName, setOrgName] = useState("")
	const [creatingOrg, setCreatingOrg] = useState(false)

	const [question, setQuestion] = useState("")
	const [asking, setAsking] = useState(false)
	const [answer, setAnswer] = useState<string | null>(null)
	const [sources, setSources] = useState<Source[]>([])
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!sessionPending && !session) router.push("/login")
	}, [sessionPending, session, router])

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

	async function handleAsk(e: React.FormEvent) {
		e.preventDefault()
		if (!activeOrg || !session) return
		setAsking(true)
		setError(null)
		setAnswer(null)
		try {
			const res = await fetch(`${API_URL}/api/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					q: question,
					orgId: activeOrg.id,
					userId: session.user.id,
				}),
			})
			if (!res.ok) throw new Error(`Request failed: ${res.status}`)
			const data = await res.json()
			setAnswer(data.answer)
			setSources(data.sources)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong")
		} finally {
			setAsking(false)
		}
	}

	if (sessionPending || orgPending) {
		return <div className="p-8 text-sm text-muted-foreground">Loading...</div>
	}
	if (!session) return null

	if (!activeOrg) {
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

	return (
		<div className="mx-auto min-h-screen max-w-2xl px-4 py-12">
			<div className="mb-1 flex items-baseline justify-between">
				<h1 className="text-lg font-medium text-foreground">
					{activeOrg.name}
				</h1>
				<a
					href="/projects"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					Projects →
				</a>
			</div>
			<p className="mb-6 text-sm text-muted-foreground">
				Ask anything across your team's knowledge base.
			</p>

			<form onSubmit={handleAsk} className="flex gap-2">
				<Input
					placeholder="How many vacation days do employees get?"
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					required
				/>
				<Button type="submit" disabled={asking}>
					{asking ? "..." : "Ask"}
				</Button>
			</form>

			{error && <p className="mt-4 text-sm text-destructive">{error}</p>}

			{answer && (
				<div className="mt-6 space-y-4">
					<p className="rounded-[var(--radius-lg)] border border-border bg-card p-4 text-sm text-foreground">
						{answer}
					</p>
					{sources.length > 0 && (
						<div className="space-y-2">
							<p className="text-xs font-medium text-muted-foreground">
								Sources
							</p>
							{sources.map((s, i) => (
								<div
									key={s.documentId + i}
									className="rounded-[var(--radius-md)] border border-border p-3 text-xs"
								>
									<p className="font-medium text-foreground">
										[{i + 1}] {s.title}
										<span className="ml-1 text-muted-foreground">
											({s.source} · {s.scope})
										</span>
									</p>
									<p className="mt-1 line-clamp-2 text-muted-foreground">
										{s.chunkContent}
									</p>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
