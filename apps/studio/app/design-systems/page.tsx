"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiSend } from "@/lib/api"
import { useCaller } from "@/lib/use-caller"

interface DesignSystem {
	id: string
	name: string
	description: string | null
}

interface DesignSystemVersion {
	id: string
	version: string
	status: "draft" | "active" | "archived"
	createdAt: string
}

function manifestTemplate(name: string) {
	return JSON.stringify(
		{
			schemaVersion: 1,
			name,
			version: "0.1.0",
			framework: "react",
			packageName: "@your-org/ui",
			preview: { entry: "./src/index.tsx", peerDependencies: [] },
			foundations: [],
			tokens: [],
			components: [],
			patterns: [],
			sourceMappings: [],
		},
		null,
		2,
	)
}

export default function DesignSystemsPage() {
	const { caller, pending, orgName } = useCaller()
	const [systems, setSystems] = useState<DesignSystem[]>([])
	const [selectedId, setSelectedId] = useState("")
	const [versions, setVersions] = useState<DesignSystemVersion[]>([])
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [manifest, setManifest] = useState("")
	const [bundleUrl, setBundleUrl] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const selected = systems.find((system) => system.id === selectedId)

	const loadSystems = useCallback(async () => {
		const data = await apiGet<{ designSystems: DesignSystem[] }>(
			"/api/design-systems",
		)
		setSystems(data.designSystems)
		setSelectedId((current) => current || data.designSystems[0]?.id || "")
	}, [])

	const loadVersions = useCallback(async () => {
		if (!selectedId) return setVersions([])
		const data = await apiGet<{ versions: DesignSystemVersion[] }>(
			`/api/design-systems/${selectedId}`,
		)
		setVersions(data.versions)
	}, [selectedId])

	useEffect(() => {
		if (!caller) return
		loadSystems().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not load systems",
			),
		)
	}, [caller, loadSystems])

	useEffect(() => {
		loadVersions().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not load versions",
			),
		)
	}, [loadVersions])

	function selectSystem(id: string) {
		setSelectedId(id)
		const system = systems.find((item) => item.id === id)
		if (system) setManifest(manifestTemplate(system.name))
		setError(null)
	}

	async function createSystem(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const data = await apiSend<{ designSystem: DesignSystem }>(
				"POST",
				"/api/design-systems",
				{ name, description: description || undefined },
			)
			setSystems((current) => [...current, data.designSystem])
			setName("")
			setDescription("")
			selectSystem(data.designSystem.id)
			setManifest(manifestTemplate(data.designSystem.name))
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not create system",
			)
		} finally {
			setBusy(false)
		}
	}

	async function createVersion(event: React.FormEvent) {
		event.preventDefault()
		if (!selected) return
		setBusy(true)
		setError(null)
		try {
			const parsed: unknown = JSON.parse(manifest)
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Manifest must be a JSON object")
			}
			await apiSend("POST", `/api/design-systems/${selected.id}/versions`, {
				manifest: parsed as Record<string, unknown>,
				bundleUrl: bundleUrl || undefined,
			})
			setBundleUrl("")
			await loadVersions()
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not create version",
			)
		} finally {
			setBusy(false)
		}
	}

	async function activateVersion(id: string) {
		setBusy(true)
		setError(null)
		try {
			await apiSend("POST", `/api/design-system-versions/${id}/activate`, {})
			await loadVersions()
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not activate version",
			)
		} finally {
			setBusy(false)
		}
	}

	if (pending || !caller) {
		return <div className="p-8 text-sm text-muted-foreground">Loading...</div>
	}

	return (
		<div className="mx-auto min-h-screen max-w-4xl px-4 py-12">
			<div className="mb-8 flex items-baseline justify-between gap-4">
				<div>
					<h1 className="text-lg font-medium text-foreground">
						Design systems
					</h1>
					<p className="text-sm text-muted-foreground">{orgName}</p>
				</div>
				<Link
					href="/projects"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					Projects →
				</Link>
			</div>

			{error && <p className="mb-5 text-sm text-destructive">{error}</p>}

			<div className="grid gap-8 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
				<section>
					<h2 className="mb-3 text-sm font-medium">Library</h2>
					<form onSubmit={createSystem} className="mb-5 space-y-2">
						<Input
							placeholder="Design system name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
						/>
						<Input
							placeholder="Description (optional)"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
						<Button type="submit" disabled={busy} className="w-full">
							Create system
						</Button>
					</form>
					<div className="space-y-1">
						{systems.map((system) => (
							<button
								key={system.id}
								type="button"
								onClick={() => selectSystem(system.id)}
								className={`w-full rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm transition-colors ${
									selectedId === system.id
										? "border-primary bg-primary/5 text-foreground"
										: "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
								}`}
							>
								<div className="font-medium">{system.name}</div>
								{system.description && (
									<div className="mt-0.5 text-xs">{system.description}</div>
								)}
							</button>
						))}
						{systems.length === 0 && (
							<p className="text-sm text-muted-foreground">
								Create a library to publish its first manifest.
							</p>
						)}
					</div>
				</section>

				<section className="border-t border-border pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
					{selected ? (
						<>
							<div className="mb-4">
								<h2 className="text-sm font-medium">{selected.name}</h2>
								<p className="text-xs text-muted-foreground">
									Submit a version, then activate it for project use.
								</p>
							</div>
							<form onSubmit={createVersion} className="space-y-3">
								<Textarea
									aria-label="Design manifest JSON"
									className="min-h-80 font-mono text-xs"
									placeholder={manifestTemplate(selected.name)}
									value={manifest}
									onChange={(event) => setManifest(event.target.value)}
									required
								/>
								<Input
									type="url"
									placeholder="Browser-compatible bundle URL (optional)"
									value={bundleUrl}
									onChange={(event) => setBundleUrl(event.target.value)}
								/>
								<Button type="submit" disabled={busy || !manifest}>
									Validate and create version
								</Button>
							</form>

							<div className="mt-8 space-y-2">
								<h3 className="text-sm font-medium">Versions</h3>
								{versions.map((version) => (
									<div
										key={version.id}
										className="flex items-center justify-between rounded-[var(--radius-md)] border border-border px-3 py-2 text-sm"
									>
										<div>
											<span className="font-medium">v{version.version}</span>
											<span className="ml-2 text-xs text-muted-foreground">
												{version.status}
											</span>
										</div>
										{version.status !== "active" && (
											<Button
												type="button"
												size="sm"
												variant="outline"
												disabled={busy}
												onClick={() => activateVersion(version.id)}
											>
												Activate
											</Button>
										)}
									</div>
								))}
								{versions.length === 0 && (
									<p className="text-sm text-muted-foreground">
										No versions yet.
									</p>
								)}
							</div>
						</>
					) : (
						<p className="text-sm text-muted-foreground">
							Select a library to manage its manifest.
						</p>
					)}
				</section>
			</div>
		</div>
	)
}
