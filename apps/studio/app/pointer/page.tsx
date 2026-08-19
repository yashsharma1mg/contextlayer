"use client"

import { useEffect, useState } from "react"

/**
 * Cursor companion.
 *
 * The window itself is moved by Rust (apps/desktop/src-tauri/src/pointer.rs) on
 * every mouse-move event, so this page never sees a coordinate — it only draws
 * the marker and whatever message arrives. That keeps the follow loop off IPC
 * entirely; at pointer speeds, streaming positions into a webview would be the
 * expensive part.
 *
 * The window is click-through, so nothing here can be interacted with. It is
 * purely something to look at.
 */

interface PointerMessage {
	text: string
	ttlMs: number
}

interface TauriGlobal {
	event: {
		listen: (
			name: string,
			cb: (event: { payload: { text: string; ttl_ms: number } }) => void,
		) => Promise<() => void>
	}
}

function tauri(): TauriGlobal | null {
	const scope = globalThis as {
		__TAURI_INTERNALS__?: unknown
		__TAURI__?: TauriGlobal
	}
	return scope.__TAURI__ ?? null
}

export default function PointerPage() {
	const [message, setMessage] = useState<PointerMessage | null>(null)

	useEffect(() => {
		const api = tauri()
		if (!api) return
		let dispose: (() => void) | undefined
		api.event
			.listen("pointer://message", (event) => {
				setMessage({
					text: event.payload.text,
					ttlMs: event.payload.ttl_ms,
				})
			})
			.then((off) => {
				dispose = off
			})
			.catch(() => undefined)
		return () => dispose?.()
	}, [])

	// Clear after the message's own lifetime rather than a fixed one, so a long
	// explanation and a one-word confirmation can each sit for the right time.
	useEffect(() => {
		if (!message) return
		const timer = window.setTimeout(() => setMessage(null), message.ttlMs)
		return () => window.clearTimeout(timer)
	}, [message])

	return (
		<div className="pointer-root">
			<style>{`
				html, body { margin: 0; background: transparent; overflow: hidden; }
				.pointer-root {
					width: 100vw; height: 100vh;
					display: flex; align-items: flex-start; gap: 6px;
					font-family: var(--font-sans), -apple-system, sans-serif;
					pointer-events: none;
					-webkit-user-select: none; user-select: none;
				}
				/* Drawn rather than a glyph: an emoji or unicode arrow would be a
				   different shape on every system, and this has to sit against a
				   real cursor at a fixed size. */
				.pointer-mark { flex: none; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.45)); }
				.pointer-bubble {
					max-width: 190px;
					margin-top: 1px;
					padding: 5px 9px;
					border-radius: 9px;
					background: var(--hud-surface, #0e0e0d);
					color: var(--hud-text, #e7e7e2);
					font-size: 11px;
					line-height: 1.35;
					box-shadow: 0 4px 14px rgb(0 0 0 / 0.35);
					animation: pointer-in 140ms cubic-bezier(0.32, 0.72, 0, 1);
				}
				@keyframes pointer-in {
					from { opacity: 0; transform: translate(-2px, -2px) scale(0.96); }
				}
				@media (prefers-reduced-motion: reduce) {
					.pointer-bubble { animation: none; }
				}
			`}</style>

			{message && (
				<>
					<svg
						className="pointer-mark"
						width="11"
						height="13"
						viewBox="0 0 11 13"
						aria-hidden
					>
						<title>Context Layer</title>
						<path
							d="M1 1 L10 6.2 L4.6 7.4 L1 12 Z"
							fill="var(--hud-accent, #60a5fa)"
						/>
					</svg>
					<span className="pointer-bubble">{message.text}</span>
				</>
			)}
		</div>
	)
}
