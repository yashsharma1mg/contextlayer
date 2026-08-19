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
 *
 * Colours come from the --hud-* tokens in globals.css. They are fixed rather
 * than theme-reactive because this panel sits against the physical notch and
 * is always dark; the values mirror the .dark palette so it reads as the same
 * product as the canvas.
 */

type Mode = "ambient" | "peek" | "focused" | "working" | "done"

/**
 * Same set and labels as the canvas composer, so the two surfaces do not drift
 * into different vocabularies for the same thing.
 */
const KINDS = [
	{ value: "auto", label: "Auto" },
	{ value: "brief", label: "Brief" },
	{ value: "user_flow", label: "Flow" },
	{ value: "ux_review", label: "Review" },
	{ value: "interface_spec", label: "Spec" },
	{ value: "react_prototype", label: "Prototype" },
] as const

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
	core: {
		invoke: <T = unknown>(
			cmd: string,
			args?: Record<string, unknown>,
		) => Promise<T>
	}
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

/**
 * The status dot reports state rather than decorating. A light that is always
 * green says nothing; these are the only four things the HUD can be doing.
 */
function dotFor(mode: Mode, error: string | null, ready: boolean) {
	if (error) return { color: "var(--hud-danger)", label: "Generation failed" }
	if (mode === "working")
		return { color: "var(--hud-accent)", label: "Generating" }
	if (mode === "done")
		return { color: "var(--hud-positive)", label: "Added to the canvas" }
	return ready
		? { color: "var(--hud-text-muted)", label: "Idle" }
		: { color: "var(--hud-border)", label: "No project yet" }
}

export default function HudPage() {
	const [mode, setMode] = useState<Mode>("ambient")
	const [ambient, setAmbient] = useState<Ambient | null>(null)
	const [prompt, setPrompt] = useState("")
	const [status, setStatus] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [kind, setKind] = useState<string>("auto")
	const [screenshot, setScreenshot] = useState<string | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)

	const expanded = mode !== "ambient"

	const send = useCallback(
		(command: string, args?: Record<string, unknown>) => {
			tauri()
				?.core.invoke(command, args)
				.catch(() => undefined)
		},
		[],
	)

	const dismiss = useCallback(() => {
		setMode("ambient")
		setPrompt("")
		setStatus(null)
		setError(null)
		setScreenshot(null)
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

	/**
	 * Put the window back to collapsed on mount.
	 *
	 * React starts in `ambient`, but the frame is owned by Rust and survives a
	 * reload — so a page that reloads while expanded comes back rendering the
	 * collapsed pill inside a 640pt window: a wide black bar across the top of
	 * the screen with a single line in it. The frame has to be told, not
	 * assumed.
	 */
	useEffect(() => {
		send("hud_collapse")
	}, [send])

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
				kind,
				screenshot: screenshot ?? undefined,
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

	/**
	 * Report the panel's real height so Rust can shrink the window to match.
	 * A fixed expanded frame leaves a transparent strip below the panel that
	 * still swallows clicks meant for the app underneath.
	 */
	useEffect(() => {
		const panel = panelRef.current
		if (!panel || !expanded) return
		const report = () =>
			send("hud_content_height", {
				height: Math.ceil(panel.getBoundingClientRect().height),
			})
		report()
		const observer = new ResizeObserver(report)
		observer.observe(panel)
		return () => observer.disconnect()
	}, [expanded, send])

	/** Grab the screen so the prompt can refer to what the user is looking at. */
	async function seeScreen() {
		const api = tauri()
		if (!api) return
		setError(null)
		setStatus("Reading the screen…")
		try {
			const shot = await api.core.invoke<{ path: string }>("screen_capture")
			// The route takes a file name, not a path — it derives the directory
			// itself so a client cannot point it at arbitrary files.
			setScreenshot(shot.path.split("/").pop() ?? null)
			setStatus("Screen attached")
		} catch (cause) {
			setScreenshot(null)
			setStatus(null)
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}

	const recency = relativeTime(ambient?.updatedAt ?? null)
	const ready = !!ambient?.projectId
	const dot = dotFor(mode, error, ready)

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
			{/*
			  Transparent window: the page paints the panel and nothing else.
			  The caret and selection are themed here because browser defaults
			  belong to no design system, and both are visible in the input.
			*/}
			<style>{`
				html, body { margin: 0; background: transparent; overflow: hidden; }
				.hud-input { caret-color: var(--hud-accent); }
				.hud-input::selection { background: color-mix(in oklab, var(--hud-accent) 35%, transparent); color: var(--hud-text); }
				.hud-input::placeholder { color: var(--hud-text-muted); }
				@keyframes hud-pulse { 50% { opacity: 0.35; } }
				.hud-dot-working { animation: hud-pulse 1.4s ease-in-out infinite; }
				@media (prefers-reduced-motion: reduce) {
					.hud-panel { transition: none !important; }
					.hud-dot-working { animation: none; }
				}
			`}</style>

			<div
				ref={panelRef}
				className="hud-panel w-full overflow-hidden rounded-b-[30px] transition-[max-height,padding] duration-200 ease-out"
				style={{
					background: "var(--hud-surface)",
					color: "var(--hud-text)",
					maxHeight: expanded ? "100vh" : "46px",
					padding: expanded ? "10px 18px 16px" : "0",
				}}
			>
				{/*
				  Collapsed, the panel spans the notch, and anything drawn in the
				  top ~32pt is behind the camera housing. So the ambient state is
				  the dot alone, pushed into the strip below the cutout; the name
				  and the rest only appear once there is room for them.
				*/}
				<div
					className={
						expanded
							? "flex h-[26px] items-center gap-2 whitespace-nowrap text-xs"
							: "flex h-full items-end justify-center pb-1"
					}
				>
					<span
						aria-hidden
						className={`size-[7px] shrink-0 rounded-full ${
							mode === "working" ? "hud-dot-working" : ""
						}`}
						style={{ background: dot.color }}
					/>
					{/* The dot is decorative; screen readers get the state as text. */}
					<span className="sr-only" role="status">
						{dot.label}
					</span>
					{expanded && (
						<span className="min-w-0 truncate font-medium">
							{ambient?.projectName ?? "Context Layer"}
						</span>
					)}
				</div>

				{expanded && (
					<div className="pt-2.5">
						<form onSubmit={submit}>
							<label className="sr-only" htmlFor="hud-prompt">
								Describe a screen to generate
							</label>
							<input
								id="hud-prompt"
								ref={inputRef}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								placeholder="Describe a screen to generate…"
								disabled={mode === "working"}
								onKeyDown={(event) => {
									// Tab cycles the kind rather than moving focus: there is
									// nowhere else in this panel worth tabbing to, and the
									// prompt should never lose the caret mid-thought.
									if (event.key !== "Tab") return
									event.preventDefault()
									const index = KINDS.findIndex((k) => k.value === kind)
									const next = event.shiftKey
										? (index - 1 + KINDS.length) % KINDS.length
										: (index + 1) % KINDS.length
									setKind(KINDS[next]?.value ?? "auto")
								}}
								aria-describedby={error ? "hud-error" : undefined}
								aria-invalid={error ? true : undefined}
								className="hud-input w-full select-text rounded-[10px] border px-3 py-2.5 text-[13px] outline-none transition-colors disabled:opacity-60 focus-visible:ring-2"
								style={{
									background: "var(--hud-raised)",
									borderColor: error
										? "var(--hud-danger)"
										: "var(--hud-border)",
									color: "var(--hud-text)",
									// biome-ignore lint/style/useNamingConvention: CSS custom property
									["--tw-ring-color" as string]: "var(--hud-accent)",
								}}
							/>
						</form>

						{/*
						  Kind row. Tab cycles it from the input, so the chips are a
						  readout of where you are rather than the only way to change
						  it — clicking still works for a pointer user.
						*/}
						<div className="mt-2 flex flex-wrap items-center gap-1">
							{KINDS.map((option) => {
								const active = option.value === kind
								return (
									<button
										key={option.value}
										type="button"
										onClick={() => setKind(option.value)}
										className="rounded-md px-1.5 py-0.5 text-[10px] transition-colors"
										style={{
											background: active ? "var(--hud-raised)" : "transparent",
											color: active
												? "var(--hud-text)"
												: "var(--hud-text-muted)",
										}}
									>
										{option.label}
									</button>
								)
							})}
							<span
								className="ml-auto text-[10px]"
								style={{ color: "var(--hud-text-muted)" }}
							>
								Tab
							</span>
						</div>

						<div className="mt-2 flex items-center gap-1.5">
							<button
								type="button"
								onClick={seeScreen}
								disabled={mode === "working"}
								className="rounded-md px-2 py-1 text-[10px] transition-colors disabled:opacity-50"
								style={{
									background: screenshot ? "var(--hud-raised)" : "transparent",
									color: screenshot
										? "var(--hud-positive)"
										: "var(--hud-text-muted)",
									border: "1px solid var(--hud-border)",
								}}
							>
								{screenshot ? "Screen attached" : "See my screen"}
							</button>
							<button
								type="button"
								onClick={() => send("screen_copy_mode")}
								className="rounded-md px-2 py-1 text-[10px] transition-colors"
								style={{
									color: "var(--hud-text-muted)",
									border: "1px solid var(--hud-border)",
								}}
							>
								Copy anything
							</button>
						</div>

						{ambient?.artifactTitle && (
							<p
								className="mt-2 truncate text-[11px]"
								style={{ color: "var(--hud-text-muted)" }}
							>
								Last: {ambient.artifactTitle}
								{recency ? ` · ${recency}` : ""}
							</p>
						)}
						{status && (
							<p
								className="mt-2 text-[11px]"
								style={{
									color:
										mode === "done"
											? "var(--hud-positive)"
											: "var(--hud-text-muted)",
								}}
							>
								{status}
							</p>
						)}
						{error && (
							<p
								id="hud-error"
								className="mt-2 text-[11px]"
								style={{ color: "var(--hud-danger)" }}
							>
								{error}. Press Enter to try again.
							</p>
						)}
						{!ready && (
							<p
								className="mt-2 text-[11px]"
								style={{ color: "var(--hud-text-muted)" }}
							>
								Open Context Layer and create a project first.
							</p>
						)}
					</div>
				)}
			</div>
		</section>
	)
}
