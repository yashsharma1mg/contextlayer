"use client"

import { Check, KeyRound, LoaderCircle, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiDelete, apiGet, apiSend } from "@/lib/api"

/**
 * Which account this Mac talks to for generation.
 *
 * Keys rather than sign-in buttons, for every provider. Neither Anthropic nor
 * OpenAI lets a third-party app spend a consumer subscription, so every route
 * that works here is billed as API usage and a key is the whole story. The rows
 * say so, so the absence of a "Sign in" button reads as a fact about the
 * providers rather than an unfinished feature.
 */

type Source = "env" | "stored" | null

interface ModelAuth {
	anthropic: { source: Source }
	openai: { source: Source }
	openrouter: { source: Source }
}

export function ModelAccountControls() {
	const [auth, setAuth] = useState<ModelAuth | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [keys, setKeys] = useState<Record<string, string>>({})
	const [detected, setDetected] = useState<{
		origin: string
		preview: string
	} | null>(null)

	const load = useCallback(async () => {
		const result = await apiGet<ModelAuth>("/api/model-auth")
		setAuth(result)
		if (!result.openai.source) {
			apiGet<{ found: boolean; origin?: string; preview?: string }>(
				"/api/model-auth/openai/detect",
			)
				.then((found) =>
					setDetected(
						found.found && found.origin && found.preview
							? { origin: found.origin, preview: found.preview }
							: null,
					),
				)
				.catch(() => setDetected(null))
		} else {
			setDetected(null)
		}
	}, [])

	useEffect(() => {
		load().catch(() => undefined)
	}, [load])

	async function run(key: string, action: () => Promise<unknown>) {
		setBusy(key)
		setError(null)
		try {
			await action()
			await load()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Something went wrong")
		} finally {
			setBusy(null)
		}
	}

	function saveKey(provider: "anthropic" | "openai") {
		const key = (keys[provider] ?? "").trim()
		if (!key) return
		return run(`${provider}-key`, async () => {
			await apiSend("PUT", `/api/model-auth/${provider}/key`, { key })
			setKeys((current) => ({ ...current, [provider]: "" }))
		})
	}

	if (!auth) return null

	const { anthropic, openai } = auth

	return (
		<section className="space-y-3 border-t border-border pt-3">
			<p className="text-xs font-medium">Model account</p>

			{/* Anthropic */}
			<div className="space-y-1.5">
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs font-medium">Anthropic</span>
					<StatusBadge source={anthropic.source} />
				</div>

				{anthropic.source === "env" && (
					<p className="text-[10px] text-muted-foreground">
						Set by an environment variable, which takes precedence over anything
						entered here.
					</p>
				)}

				{anthropic.source === "stored" && (
					<div className="flex items-center justify-between gap-2">
						<span className="text-[10px] text-muted-foreground">
							API key stored in your Keychain
						</span>
						<Button
							variant="ghost"
							size="xs"
							disabled={busy === "anthropic-remove"}
							onClick={() =>
								run("anthropic-remove", () =>
									apiDelete("/api/model-auth/anthropic"),
								)
							}
						>
							<X /> Remove
						</Button>
					</div>
				)}

				{!anthropic.source && (
					<KeyField
						placeholder="Anthropic API key"
						value={keys.anthropic ?? ""}
						busy={busy === "anthropic-key"}
						onChange={(value) =>
							setKeys((current) => ({ ...current, anthropic: value }))
						}
						onSave={() => saveKey("anthropic")}
					/>
				)}

				<p className="text-[10px] text-muted-foreground">
					Billed as API usage from the Claude Console. A Claude Pro or Max
					subscription cannot be used here — subscription credentials are
					blocked outside Anthropic&rsquo;s own apps.
				</p>
			</div>

			{/* OpenAI */}
			<div className="space-y-1.5 border-t border-border pt-3">
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs font-medium">OpenAI</span>
					<StatusBadge source={openai.source} />
				</div>

				{openai.source === "env" && (
					<p className="text-[10px] text-muted-foreground">
						Set by an environment variable, which takes precedence over anything
						entered here.
					</p>
				)}

				{openai.source === "stored" && (
					<div className="flex items-center justify-between gap-2">
						<span className="text-[10px] text-muted-foreground">
							API key stored in your Keychain
						</span>
						<Button
							variant="ghost"
							size="xs"
							disabled={busy === "openai-remove"}
							onClick={() =>
								run("openai-remove", () => apiDelete("/api/model-auth/openai"))
							}
						>
							<X /> Remove
						</Button>
					</div>
				)}

				{!openai.source && detected && (
					<Button
						variant="outline"
						size="xs"
						disabled={busy === "openai-import"}
						onClick={() =>
							run("openai-import", () =>
								apiSend("POST", "/api/model-auth/openai/import", {}),
							)
						}
					>
						<KeyRound /> Use the key in {detected.origin} ({detected.preview})
					</Button>
				)}

				{!openai.source && (
					<KeyField
						placeholder="OpenAI API key"
						value={keys.openai ?? ""}
						busy={busy === "openai-key"}
						onChange={(value) =>
							setKeys((current) => ({ ...current, openai: value }))
						}
						onSave={() => saveKey("openai")}
					/>
				)}

				<p className="text-[10px] text-muted-foreground">
					Billed as API usage. “Sign in with ChatGPT” shares your name and email
					only — a ChatGPT plan cannot be spent here.
				</p>
			</div>

			{error && <p className="text-[10px] text-destructive">{error}</p>}
		</section>
	)
}

function StatusBadge({ source }: { source: Source }) {
	if (!source) {
		return (
			<span className="text-[10px] text-muted-foreground">Not connected</span>
		)
	}
	return (
		<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
			<Check className="size-3" style={{ color: "var(--creed-accent)" }} />
			{source === "env" ? "Environment" : "Key saved"}
		</span>
	)
}

/** Keys are validated against the provider before they are stored, so a typo
 * surfaces here rather than as a failed generation later. */
function KeyField({
	placeholder,
	value,
	busy,
	onChange,
	onSave,
}: {
	placeholder: string
	value: string
	busy: boolean
	onChange: (value: string) => void
	onSave: () => void
}) {
	return (
		<div className="flex items-center gap-1.5">
			<Input
				type="password"
				className="h-7 text-xs"
				placeholder={placeholder}
				value={value}
				autoComplete="off"
				spellCheck={false}
				disabled={busy}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") onSave()
				}}
			/>
			<Button
				variant="outline"
				size="xs"
				disabled={busy || !value.trim()}
				onClick={onSave}
			>
				{busy ? <LoaderCircle className="animate-spin" /> : "Save"}
			</Button>
		</div>
	)
}
