"use client"

import Link from "next/link"
import { use, useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiSend } from "@/lib/api"
import { useCaller } from "@/lib/use-caller"

interface Idea {
	id: string
	kind: "concept" | "ui"
	title: string
	body: string | null
	generatedCode: string | null
	prompt: string
	sourceRefs: { documentId: string; title: string; url: string | null }[] | null
	createdAt: string
}

interface Comment {
	id: string
	authorUserId: string
	body: string
	createdAt: string
}

export default function ProjectPage({
	params,
}: {
	params: Promise<{ id: string }>
}) {
	const { id: projectId } = use(params)
	const { caller, pending } = useCaller()

	const [ideas, setIdeas] = useState<Idea[]>([])
	const [prompt, setPrompt] = useState("")
	const [kind, setKind] = useState<"concept" | "ui">("concept")
	const [generating, setGenerating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [openIdea, setOpenIdea] = useState<Idea | null>(null)
	const [comments, setComments] = useState<Comment[]>([])
	const [commentText, setCommentText] = useState("")
	const [sharing, setSharing] = useState(false)

	const load = useCallback(async () => {
		if (!caller) return
		const data = await apiGet<{ ideas: Idea[] }>(
			`/api/projects/${projectId}/ideas`,
			caller,
		)
		setIdeas(data.ideas)
	}, [caller, projectId])

	useEffect(() => {
		load().catch((e) => setError(e.message))
	}, [load])

	async function handleGenerate(e: React.FormEvent) {
		e.preventDefault()
		if (!caller) return
		setGenerating(true)
		setError(null)
		try {
			await apiSend("POST", `/api/ideas/${kind}`, {
				projectId,
				prompt,
				...caller,
			})
			setPrompt("")
			await load()
		} catch (e) {
			setError(e instanceof Error ? e.message : "Generation failed")
		} finally {
			setGenerating(false)
		}
	}

	async function openIdeaPanel(idea: Idea) {
		setOpenIdea(idea)
		setComments([])
		if (!caller) return
		const data = await apiGet<{ comments: Comment[] }>(
			`/api/ideas/${idea.id}/comments`,
			caller,
		)
		setComments(data.comments)
	}

	async function handleComment(e: React.FormEvent) {
		e.preventDefault()
		if (!caller || !openIdea) return
		await apiSend("POST", `/api/ideas/${openIdea.id}/comments`, {
			body: commentText,
			...caller,
		})
		setCommentText("")
		const data = await apiGet<{ comments: Comment[] }>(
			`/api/ideas/${openIdea.id}/comments`,
			caller,
		)
		setComments(data.comments)
	}

	async function handleShareToOrg() {
		if (!caller) return
		setSharing(true)
		try {
			await apiSend("PATCH", `/api/projects/${projectId}/share`, {
				visibility: "org",
				...caller,
			})
		} finally {
			setSharing(false)
		}
	}

	if (pending || !caller) {
		return <div className="p-8 text-sm text-muted-foreground">Loading...</div>
	}

	return (
		<div className="mx-auto min-h-screen max-w-5xl px-4 py-12">
			<div className="mb-6 flex items-center justify-between">
				<Link
					href="/projects"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					← Projects
				</Link>
				<Button
					variant="outline"
					size="sm"
					onClick={handleShareToOrg}
					disabled={sharing}
				>
					{sharing ? "..." : "Share to org"}
				</Button>
			</div>

			<form onSubmit={handleGenerate} className="mb-8 space-y-2">
				<Textarea
					placeholder={
						kind === "concept"
							? "Describe an idea to develop — it'll be grounded in your team's knowledge base..."
							: "Describe a screen or UI to mock up..."
					}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					required
					rows={3}
				/>
				<div className="flex items-center gap-2">
					<div className="flex rounded-[var(--radius-md)] border border-border p-0.5">
						<button
							type="button"
							onClick={() => setKind("concept")}
							className={`rounded-[var(--radius-sm)] px-3 py-1 text-xs ${kind === "concept" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
						>
							Concept
						</button>
						<button
							type="button"
							onClick={() => setKind("ui")}
							className={`rounded-[var(--radius-sm)] px-3 py-1 text-xs ${kind === "ui" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
						>
							UI mockup
						</button>
					</div>
					<Button type="submit" disabled={generating}>
						{generating ? "Generating..." : "Generate"}
					</Button>
				</div>
			</form>

			{error && <p className="mb-4 text-sm text-destructive">{error}</p>}

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				{ideas.map((idea) => (
					<button
						key={idea.id}
						type="button"
						onClick={() => openIdeaPanel(idea)}
						className="rounded-[var(--radius-lg)] border border-border bg-card p-4 text-left hover:bg-muted"
					>
						<div className="mb-1 flex items-center justify-between">
							<span className="text-sm font-medium text-foreground">
								{idea.title}
							</span>
							<span className="text-xs text-muted-foreground">{idea.kind}</span>
						</div>
						{idea.kind === "ui" && idea.generatedCode ? (
							<iframe
								title={idea.title}
								srcDoc={idea.generatedCode}
								sandbox="allow-scripts"
								className="pointer-events-none h-48 w-full rounded-[var(--radius-md)] border border-border bg-white"
							/>
						) : (
							<p className="line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">
								{idea.body}
							</p>
						)}
					</button>
				))}
				{ideas.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No ideas yet — write a prompt above.
					</p>
				)}
			</div>

			{openIdea && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
					<div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card">
						<div className="flex items-center justify-between border-b border-border p-4">
							<h2 className="text-sm font-medium text-foreground">
								{openIdea.title}
							</h2>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setOpenIdea(null)}
							>
								Close
							</Button>
						</div>
						<div className="flex-1 overflow-auto p-4">
							{openIdea.kind === "ui" && openIdea.generatedCode ? (
								<iframe
									title={openIdea.title}
									srcDoc={openIdea.generatedCode}
									sandbox="allow-scripts"
									className="h-[55vh] w-full rounded-[var(--radius-md)] border border-border bg-white"
								/>
							) : (
								<p className="whitespace-pre-line text-sm text-foreground">
									{openIdea.body}
								</p>
							)}
							{openIdea.sourceRefs && openIdea.sourceRefs.length > 0 && (
								<p className="mt-3 text-xs text-muted-foreground">
									Grounded in:{" "}
									{openIdea.sourceRefs.map((s) => s.title).join(", ")}
								</p>
							)}

							<div className="mt-6 space-y-2 border-t border-border pt-4">
								{comments.map((cm) => (
									<div
										key={cm.id}
										className="rounded-[var(--radius-md)] border border-border p-2"
									>
										<p className="text-xs text-foreground">{cm.body}</p>
										<p className="mt-1 text-[10px] text-muted-foreground">
											{cm.authorUserId} ·{" "}
											{new Date(cm.createdAt).toLocaleString()}
										</p>
									</div>
								))}
								<form onSubmit={handleComment} className="flex gap-2 pt-2">
									<Input
										placeholder="Add a comment..."
										value={commentText}
										onChange={(e) => setCommentText(e.target.value)}
										required
									/>
									<Button type="submit" size="sm">
										Send
									</Button>
								</form>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}
