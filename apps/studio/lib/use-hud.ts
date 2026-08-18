"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * Controls the notch HUD from the canvas.
 *
 * Tauri is reached through the `__TAURI__` global rather than an import, so
 * Studio takes no dependency on @tauri-apps/api for something that is inert in
 * a browser. `available` is false outside the desktop shell, which is what the
 * canvas uses to decide whether the toggle belongs on screen at all.
 */
interface TauriGlobal {
	core: {
		invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
	}
}

function tauri(): TauriGlobal | null {
	return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null
}

export function useHud() {
	const [available, setAvailable] = useState(false)
	const [visible, setVisible] = useState(false)

	// Read the window's real state rather than assuming: the hotkey can reveal
	// the HUD without the canvas knowing, so the toggle would otherwise drift.
	const sync = useCallback(async () => {
		const api = tauri()
		if (!api) return
		try {
			setVisible(await api.core.invoke<boolean>("hud_visible"))
			setAvailable(true)
		} catch {
			setAvailable(false)
		}
	}, [])

	useEffect(() => {
		sync()
		// Cheap poll: the only other thing that changes visibility is the global
		// hotkey, and a missed update just leaves the toggle briefly stale.
		const timer = window.setInterval(sync, 4000)
		return () => window.clearInterval(timer)
	}, [sync])

	const toggle = useCallback(async () => {
		const api = tauri()
		if (!api) return
		const next = !visible
		// Optimistic: the window responds immediately, and sync corrects it if
		// the call fails.
		setVisible(next)
		try {
			setVisible(
				await api.core.invoke<boolean>("hud_set_visible", { visible: next }),
			)
		} catch {
			sync()
		}
	}, [visible, sync])

	return { available, visible, toggle }
}
