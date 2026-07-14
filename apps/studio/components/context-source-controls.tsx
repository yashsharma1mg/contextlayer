"use client"

import {
	Check,
	DatabaseBackup,
	LoaderCircle,
	RefreshCw,
	RotateCcw,
	Unplug,
	X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { API_URL, apiDelete, apiGet, apiSend, waitForJob } from "@/lib/api"

type Provider =
	| "figma"
	| "confluence"
	| "github"
	| "notion"
	| "google_drive"
	| "slack"
	| "mcp"

type ConnectionStatus = {
	connected: boolean
	metadata?: {
		access?: { scope?: "personal" | "org" | "team" }
		[key: string]: unknown
	} | null
	health?: {
		lastSyncedAt: string | null
		lastError: string | null
	} | null
}

type Job = {
	id: string
	type: string
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
	progress: number
	error: string | null
}

const providers: { id: Exclude<Provider, "mcp">; label: string }[] = [
	{ id: "figma", label: "Figma" },
	{ id: "confluence", label: "Confluence" },
	{ id: "github", label: "GitHub" },
	{ id: "notion", label: "Notion" },
	{ id: "google_drive", label: "Google Drive" },
	{ id: "slack", label: "Slack" },
]

const emptyConnections = Object.fromEntries(
	[...providers.map(({ id }) => id), "mcp"].map((id) => [
		id,
		{ connected: false },
	]),
) as Record<Provider, ConnectionStatus>

const consentOptions = [
	{
		provider: "nvidia",
		label: "NVIDIA",
		purposes: ["embeddings"],
		boundary: "Text chunks for semantic embeddings",
	},
	{
		provider: "openrouter",
		label: "OpenRouter",
		purposes: ["generation", "media"],
		boundary: "Selected context and images for generation",
	},
	{
		provider: "openai",
		label: "OpenAI",
		purposes: ["media"],
		boundary: "Selected audio for transcription",
	},
] as const

export function ProviderConsentControls({ canManage }: { canManage: boolean }) {
	const [enabled, setEnabled] = useState<Record<string, boolean>>({})
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [backups, setBackups] = useState<
		{ name: string; size: number; createdAt: string }[]
	>([])
	const [backupBusy, setBackupBusy] = useState(false)

	const load = useCallback(async () => {
		const result = await apiGet<{
			consents: { provider: string; revokedAt: string | null }[]
		}>("/api/privacy/consents")
		setEnabled(
			Object.fromEntries(
				result.consents.map((consent) => [
					consent.provider,
					!consent.revokedAt,
				]),
			),
		)
	}, [])

	useEffect(() => {
		load().catch(() => undefined)
		if (canManage) {
			apiGet<{ backups: { name: string; size: number; createdAt: string }[] }>(
				"/api/privacy/backups",
			)
				.then((result) => setBackups(result.backups))
				.catch(() => undefined)
		}
	}, [canManage, load])

	async function createBackup() {
		setBackupBusy(true)
		setError(null)
		try {
			await apiSend("POST", "/api/privacy/backups", {})
			const result = await apiGet<{
				backups: { name: string; size: number; createdAt: string }[]
			}>("/api/privacy/backups")
			setBackups(result.backups)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Backup failed")
		} finally {
			setBackupBusy(false)
		}
	}

	async function scheduleRestore(name: string) {
		if (!window.confirm("Restore this backup when Context Layer next starts?"))
			return
		setBackupBusy(true)
		setError(null)
		try {
			await apiSend("POST", `/api/privacy/backups/${name}/restore`, {})
			window.alert(
				"Restore scheduled. Quit and reopen Context Layer to apply it.",
			)
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Restore could not be scheduled",
			)
		} finally {
			setBackupBusy(false)
		}
	}

	async function toggle(
		option: (typeof consentOptions)[number],
		checked: boolean,
	) {
		setBusy(option.provider)
		setError(null)
		try {
			if (checked) {
				await apiSend("PUT", `/api/privacy/consents/${option.provider}`, {
					purposes: [...option.purposes],
				})
			} else {
				await apiDelete(`/api/privacy/consents/${option.provider}`)
			}
			setEnabled((current) => ({ ...current, [option.provider]: checked }))
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Consent update failed")
		} finally {
			setBusy(null)
		}
	}

	return (
		<section className="space-y-2 border-t border-border pt-3">
			<p className="text-xs font-medium">Remote AI data boundaries</p>
			{consentOptions.map((option) => (
				<label
					key={option.provider}
					className="flex items-start gap-2 py-1 text-xs"
				>
					<input
						type="checkbox"
						className="mt-0.5 size-3.5 accent-blue-600"
						checked={enabled[option.provider] ?? false}
						disabled={busy === option.provider}
						onChange={(event) => toggle(option, event.target.checked)}
					/>
					<span>
						<span className="font-medium">{option.label}</span>
						<span className="block text-[10px] text-muted-foreground">
							{option.boundary}
						</span>
					</span>
				</label>
			))}
			<p className="text-[10px] text-muted-foreground">
				Workspace originals remain on this Mac. Only the boundary shown above is
				sent.
			</p>
			{error && <p className="text-[10px] text-red-600">{error}</p>}
			{canManage && (
				<div className="space-y-2 border-t border-border pt-3">
					<div className="flex items-center justify-between gap-2">
						<p className="text-xs font-medium">Local database backups</p>
						<Button
							variant="outline"
							size="xs"
							disabled={backupBusy}
							onClick={createBackup}
						>
							<DatabaseBackup /> Back up
						</Button>
					</div>
					{backups.slice(0, 5).map((backup) => (
						<div
							key={backup.name}
							className="flex items-center justify-between gap-2 text-[10px]"
						>
							<span className="min-w-0 truncate text-muted-foreground">
								{new Date(backup.createdAt).toLocaleString()} ·{" "}
								{Math.max(1, Math.round(backup.size / 1024 / 1024))} MB
							</span>
							<Button
								aria-label={`Restore ${backup.name}`}
								title="Restore on next launch"
								variant="ghost"
								size="icon-xs"
								disabled={backupBusy}
								onClick={() => scheduleRestore(backup.name)}
							>
								<RotateCcw />
							</Button>
						</div>
					))}
				</div>
			)}
		</section>
	)
}

export function SourceControls<TNode extends { id: string }>({
	projectId,
	canManageConnections,
	onNodeAdded,
}: {
	projectId: string
	canManageConnections: boolean
	onNodeAdded: (node: TNode) => void
}) {
	const [connections, setConnections] = useState(emptyConnections)
	const [jobs, setJobs] = useState<Job[]>([])
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [url, setUrl] = useState("")
	const [figmaFileUrl, setFigmaFileUrl] = useState("")
	const [githubRepositories, setGithubRepositories] = useState("")
	const [mcpName, setMcpName] = useState("")
	const [mcpUrl, setMcpUrl] = useState("")
	const [mcpToken, setMcpToken] = useState("")

	const load = useCallback(async () => {
		const ids: Provider[] = [...providers.map(({ id }) => id), "mcp"]
		const [statuses, jobResult] = await Promise.all([
			Promise.all(
				ids.map((provider) =>
					apiGet<ConnectionStatus>(`/api/connections/${provider}/status`).catch(
						(): ConnectionStatus => ({ connected: false }),
					),
				),
			),
			apiGet<{ jobs: Job[] }>("/api/jobs", { limit: 10 }),
		])
		setConnections(
			Object.fromEntries(
				ids.map((provider, index) => [provider, statuses[index]]),
			) as Record<Provider, ConnectionStatus>,
		)
		setJobs(jobResult.jobs.filter((job) => job.type.startsWith("connector.")))
		const repositories = statuses[ids.indexOf("github")]?.metadata?.repositories
		if (Array.isArray(repositories))
			setGithubRepositories(repositories.join(", "))
	}, [])

	useEffect(() => {
		load().catch(() => undefined)
		const timer = window.setInterval(() => load().catch(() => undefined), 5_000)
		return () => window.clearInterval(timer)
	}, [load])

	async function run(action: string, operation: () => Promise<unknown>) {
		setBusy(action)
		setError(null)
		setNotice(null)
		try {
			await operation()
			setNotice("Queued. Progress appears below.")
			await load()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Request failed")
		} finally {
			setBusy(null)
		}
	}

	async function importUrl(event: React.FormEvent) {
		event.preventDefault()
		await run("url", async () => {
			const queued = await apiSend<{ job: Job }>("POST", "/api/memories/url", {
				url,
				scope: "personal",
			})
			const completed = await waitForJob(queued.job.id)
			const documentId = completed.result?.documentId
			if (typeof documentId !== "string")
				throw new Error("URL import returned no document")
			const result = await apiSend<{ node: TNode }>(
				"POST",
				`/api/projects/${projectId}/documents/${documentId}/nodes`,
				{ x: 180, y: 180 },
			)
			onNodeAdded(result.node)
			setUrl("")
			setNotice("URL added to the canvas.")
		})
	}

	async function saveGitHubSources(event: React.FormEvent) {
		event.preventDefault()
		await run("github-config", () =>
			apiSend("PATCH", "/api/connections/github/config", {
				repositories: githubRepositories
					.split(",")
					.map((repository) => repository.trim())
					.filter(Boolean),
			}),
		)
	}

	async function connectMcp(event: React.FormEvent) {
		event.preventDefault()
		await run("mcp-connect", async () => {
			await apiSend("POST", "/api/connections/mcp/connect", {
				name: mcpName,
				baseUrl: mcpUrl,
				bearerToken: mcpToken || undefined,
			})
			setMcpToken("")
		})
	}

	async function setAccess(provider: Provider, scope: "personal" | "org") {
		await run(`${provider}-access`, () =>
			apiSend("PATCH", `/api/connections/${provider}/access`, { scope }),
		)
	}

	const activeJob = useMemo(
		() =>
			jobs.find((job) => job.status === "queued" || job.status === "running"),
		[jobs],
	)

	return (
		<>
			<section className="space-y-2 border-t border-border pt-3">
				<p className="text-xs font-medium">Add a web source</p>
				<form className="flex gap-1" onSubmit={importUrl}>
					<Input
						type="url"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://example.com"
						required
					/>
					<Button type="submit" size="xs" disabled={busy === "url"}>
						Add
					</Button>
				</form>
			</section>

			<section className="space-y-1 border-t border-border pt-3">
				<p className="pb-1 text-xs font-medium">Connections</p>
				{providers.map((provider) => {
					const status = connections[provider.id]
					return (
						<div
							key={provider.id}
							className="border-b border-border/70 py-2 last:border-0"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="flex min-w-0 items-center gap-1.5 text-xs">
									{status.connected ? (
										<Check className="size-3 text-emerald-600" />
									) : (
										<Unplug className="size-3 text-muted-foreground" />
									)}
									{provider.label}
								</span>
								{canManageConnections && (
									<div className="flex gap-1">
										{status.connected && (
											<>
												<Button
													aria-label={`Sync ${provider.label}`}
													title={`Sync ${provider.label}`}
													variant="ghost"
													size="icon-xs"
													disabled={busy === provider.id}
													onClick={() =>
														run(provider.id, () =>
															apiSend(
																"POST",
																`/api/connections/${provider.id}/sync`,
																{},
															),
														)
													}
												>
													<RefreshCw />
												</Button>
												<Button
													aria-label={`Disconnect ${provider.label}`}
													title={`Disconnect ${provider.label}`}
													variant="ghost"
													size="icon-xs"
													disabled={busy === `${provider.id}-disconnect`}
													onClick={() =>
														run(`${provider.id}-disconnect`, () =>
															apiDelete(`/api/connections/${provider.id}`),
														)
													}
												>
													<Unplug />
												</Button>
											</>
										)}
										<Button asChild size="xs" variant="outline">
											<a
												href={`${API_URL}/api/connections/${provider.id}/start`}
											>
												{status.connected ? "Reconnect" : "Connect"}
											</a>
										</Button>
									</div>
								)}
							</div>
							{status.health?.lastError && (
								<p className="mt-1 truncate text-[10px] text-red-600">
									{status.health.lastError}
								</p>
							)}
							{status.connected && canManageConnections && (
								<label className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
									<span>Imported content access</span>
									<select
										className="h-6 border border-border bg-background px-1 text-foreground"
										value={status.metadata?.access?.scope ?? "personal"}
										disabled={busy === `${provider.id}-access`}
										onChange={(event) =>
											void setAccess(
												provider.id,
												event.target.value as "personal" | "org",
											)
										}
									>
										<option value="personal">Only me</option>
										<option value="org">Organization</option>
									</select>
								</label>
							)}
						</div>
					)
				})}

				{connections.figma.connected && canManageConnections && (
					<form
						className="flex gap-1 pt-2"
						onSubmit={(event) => {
							event.preventDefault()
							void run("figma-watch", async () => {
								await apiSend("POST", "/api/connections/figma/watch", {
									fileUrl: figmaFileUrl,
								})
								setFigmaFileUrl("")
							})
						}}
					>
						<Input
							type="url"
							value={figmaFileUrl}
							onChange={(event) => setFigmaFileUrl(event.target.value)}
							placeholder="Figma file URL"
							required
						/>
						<Button type="submit" size="xs" disabled={busy === "figma-watch"}>
							Watch
						</Button>
					</form>
				)}

				{connections.github.connected && canManageConnections && (
					<form className="space-y-1 pt-2" onSubmit={saveGitHubSources}>
						<Input
							value={githubRepositories}
							onChange={(event) => setGithubRepositories(event.target.value)}
							placeholder="owner/repo, owner/another"
						/>
						<Button type="submit" size="xs" variant="outline">
							Save GitHub sources
						</Button>
					</form>
				)}
				{!canManageConnections && (
					<p className="pt-1 text-[10px] text-muted-foreground">
						Organization owner access is required to change connections.
					</p>
				)}
			</section>

			{canManageConnections && (
				<form
					className="space-y-1 border-t border-border pt-3"
					onSubmit={connectMcp}
				>
					<p className="text-xs font-medium">Remote MCP source</p>
					<Input
						value={mcpName}
						onChange={(event) => setMcpName(event.target.value)}
						placeholder="Name"
						required
					/>
					<Input
						type="url"
						value={mcpUrl}
						onChange={(event) => setMcpUrl(event.target.value)}
						placeholder="HTTPS endpoint"
						required
					/>
					<Input
						type="password"
						value={mcpToken}
						onChange={(event) => setMcpToken(event.target.value)}
						placeholder="Bearer token (optional)"
					/>
					<Button
						type="submit"
						size="xs"
						variant="outline"
						disabled={busy === "mcp-connect"}
					>
						{connections.mcp.connected
							? "Update MCP source"
							: "Connect MCP source"}
					</Button>
				</form>
			)}

			{activeJob && (
				<div className="flex items-center gap-2 border-t border-border pt-3 text-[10px] text-muted-foreground">
					<LoaderCircle className="size-3 animate-spin" />
					<span className="min-w-0 flex-1 truncate">
						{activeJob.type.replace("connector.", "")} · {activeJob.progress}%
					</span>
					<Button
						aria-label="Cancel sync"
						title="Cancel sync"
						variant="ghost"
						size="icon-xs"
						onClick={() =>
							apiSend("POST", `/api/jobs/${activeJob.id}/cancel`, {}).then(load)
						}
					>
						<X />
					</Button>
				</div>
			)}
			{notice && <p className="text-[10px] text-muted-foreground">{notice}</p>}
			{error && <p className="text-[10px] text-red-600">{error}</p>}
		</>
	)
}
