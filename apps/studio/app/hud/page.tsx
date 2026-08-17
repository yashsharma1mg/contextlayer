"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { apiGet, apiSend } from "@/lib/api"

/**
 * The notch HUD.
 *
 * Served from the Studio origin rather than a tauri:// page so it carries the
 * Better Auth session cookie the API requires; that also means it reuses the
 * same fetch helpers and design tokens as the canvas.
 *
 * The window frame is owned by Rust (apps/desktop/src-tauri/src/hud.rs) and
 * resized instantly. Everything here animates inside a frame that is already
 * the right size. Hover must never steal focus, so it only asks Rust to grow
 * the frame — taking key status is the hotkey's job alone.
 */

type Mode = "ambient" | "peek" | "focused" | "working" | "done"

interface Ambient {
	projectId: string | null
	projectName: string | null
	artifactTitle: string | null
	updatedAt: string | null
}

/**
 * Tauri is exposed as a global (withGlobalTauri) rather than imported, so
 * Studio takes no dependency on @tauri-apps/api for a page that is inert in a
 * browser anyway.
 */
interface TauriGlobal {
	core: { invoke: (cmd: string) => Promise<unknown> }
	event: {
		listen: (name: string, cb: () => void) => Promise<() => void>
	}
}

function tauri(): TauriGlobal | null {
	return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null
}

function relativeTime(iso: string | null) {
	if (!iso) return null
	const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
	if (!Number.isFinite(minutes) || minutes < 0) return null
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.round(hours / 24)}d ago`
}

export default function HudPage() {
	const [mode, setMode] = useState<Mode>("ambient")
	const [ambient, setAmbient] = useState<Ambient | null>(null)
	const [prompt, setPrompt] = useState("")
	const [status, setStatus] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	const expanded = mode !== "ambient"

	const send = useCallback((command: string) => {
		tauri()
			?.core.invoke(command)
			.catch(() => undefined)
	}, [])

	const dismiss = useCallback(() => {
		setMode("ambient")
		setPrompt("")
		setStatus(null)
		setError(null)
		send("hud_dismiss")
	}, [send])

	/**
	 * Ambient content: which project the hotkey will drop work into, and the
	 * most recent artifact on it. /api/projects is ordered by updatedAt, so the
	 * first row is the one the user last touched.
	 */
	const loadAmbient = useCallback(async () => {
		try {
			const { projects } = await apiGet<{
				projects: { id: string; name: string; updatedAt: string | null }[]
			}>("/api/projects")
			const project = projects[0]
			if (!project) {
				setAmbient({
					projectId: null,
					projectName: null,
					artifactTitle: null,
					updatedAt: null,
				})
				return
			}
			const workspace = await apiGet<{
				nodes: { kind: string; label: string }[]
			}>(`/api/projects/${project.id}/canvas`)
			const artifact = workspace.nodes
				.filter((node) => node.kind === "artifact")
				.at(-1)
			setAmbient({
				projectId: project.id,
				projectName: project.name,
				artifactTitle: artifact?.label ?? null,
				updatedAt: project.updatedAt,
			})
		} catch {
			// Studio may still be booting behind the splash screen; the pill
			// just stays quiet rather than showing an error at the notch.
		}
	}, [])

	useEffect(() => {
		loadAmbient()
	}, [loadAmbient])

	// The hotkey focuses. Hover only ever peeks.
	useEffect(() => {
		const api = tauri()
		if (!api) return
		let dispose: (() => void) | undefined
		api.event
			.listen("hud://focus", () => {
				setMode("focused")
				// Rust has already grown the frame by the time this fires.
				requestAnimationFrame(() => inputRef.current?.focus())
			})
			.then((off) => {
				dispose = off
			})
			.catch(() => undefined)
		return () => dispose?.()
	}, [])

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") dismiss()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [dismiss])

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		if (!prompt.trim() || !ambient?.projectId) return
		setMode("working")
		setError(null)
		setStatus("Generating…")
		try {
			await apiSend("POST", `/api/projects/${ambient.projectId}/generate`, {
				prompt,
				kind: "auto",
			})
			setStatus("Added to the canvas")
			setMode("done")
			loadAmbient()
			// Long enough to read, short enough not to sit in the way.
			setTimeout(dismiss, 2200)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Generation failed")
			setMode("focused")
			setStatus(null)
		}
	}

	const recency = relativeTime(ambient?.updatedAt ?? null)

	return (
		// Hover is an affordance, not the only way in: the global ⌥Space hotkey
		// opens and focuses the same panel without a pointer.
		<section
			aria-label="Context Layer HUD"
			className="flex h-screen w-screen items-start justify-center"
			onMouseEnter={() => {
				if (mode !== "ambient") return
				setMode("peek")
				send("hud_expand")
			}}
			onMouseLeave={() => {
				// Once the panel owns the keyboard, leaving must not close it.
				if (mode !== "peek") return
				setMode("ambient")
				send("hud_collapse")
			}}
		>
			{/* Transparent window: the page paints the panel, nothing else. */}
			<style>
				{"html,body{margin:0;background:transparent;overflow:hidden}"}
			</style>

			<div
				className={`w-full overflow-hidden rounded-b-[30px] bg-[#101211] text-[#f4f5f6] transition-all duration-200 ease-out ${
					expanded
						? "max-h-screen px-[18px] pt-[10px] pb-4"
						: "max-h-[38px] px-[14px] py-[6px]"
				}`}
			>
				<div className="flex h-[26px] items-center gap-2 whitespace-nowrap text-xs">
					<span className="size-[7px] shrink-0 rounded-full bg-emerald-400" />
					<span className="font-medium">
						{ambient?.projectName ?? "Context Layer"}
					</span>
					{!expanded && ambient?.artifactTitle && (
						<span className="overflow-hidden text-ellipsis text-[#8b9199]">
							{ambient.artifactTitle}
							{recency && <span className="text-[#6b7178]"> · {recency}</span>}
						</span>
					)}
				</div>

				{expanded && (
					<div className="pt-2.5">
						<form onSubmit={submit}>
							<input
								ref={inputRef}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								placeholder="Describe a screen to generate…"
								disabled={mode === "working"}
								className="w-full select-text rounded-[10px] border border-[#24272a] bg-[#171918] px-3 py-2.5 text-[13px] text-[#f4f5f6] outline-none focus:border-[#2f6df6]"
							/>
						</form>
						{ambient?.artifactTitle && (
							<p className="mt-2 text-[11px] text-[#6b7178]">
								Last: {ambient.artifactTitle}
								{recency ? ` · ${recency}` : ""}
							</p>
						)}
						{status && (
							<p className="mt-2 text-[11px] text-emerald-400">{status}</p>
						)}
						{error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
						{!ambient?.projectId && (
							<p className="mt-2 text-[11px] text-red-400">
								Create a project in Context Layer first.
							</p>
						)}
					</div>
				)}
			</div>
		</section>
	)
}
