"use client"

import { ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

const scopeLabels: Record<string, string> = {
	"knowledge:read": "Search and read accessible knowledge",
	"canvas:read": "Read projects, canvases, and artifacts",
	"design:read": "Read pinned design-system assets",
	"artifacts:write": "Create and revise project artifacts",
	"generation:write": "Validate plans and generate React files",
	"publication:write": "Preview and approve GitHub publication",
	profile: "Read your display name",
	openid: "Confirm your identity",
	offline_access: "Stay connected until access is revoked",
}

export default function ConsentPage() {
	const [scopes, setScopes] = useState<string[]>([])
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const requested = new URLSearchParams(window.location.search)
			.get("scope")
			?.split(/\s+/)
			.filter(Boolean)
		setScopes(requested ?? [])
	}, [])

	async function decide(accept: boolean) {
		setBusy(true)
		setError(null)
		const result = await authClient.oauth2.consent({
			accept,
			scope: scopes.join(" ") || undefined,
		})
		if (result.error) {
			setError(result.error.message ?? "Authorization could not be completed")
			setBusy(false)
			return
		}
		if (result.data?.url) window.location.assign(result.data.url)
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-4">
			<section className="w-full max-w-md rounded-md border border-border bg-card p-6">
				<div className="flex items-center gap-2">
					<ShieldCheck className="size-5 text-blue-600" />
					<h1 className="text-base font-medium">Authorize MCP access</h1>
				</div>
				<ul className="my-5 divide-y divide-border border-y border-border text-sm">
					{scopes.map((scope) => (
						<li key={scope} className="py-2.5">
							<p className="font-medium">{scopeLabels[scope] ?? scope}</p>
							<p className="text-xs text-muted-foreground">{scope}</p>
						</li>
					))}
				</ul>
				<div className="flex justify-end gap-2">
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => decide(false)}
					>
						Deny
					</Button>
					<Button disabled={busy} onClick={() => decide(true)}>
						Allow access
					</Button>
				</div>
				{error && <p className="mt-3 text-sm text-destructive">{error}</p>}
			</section>
		</main>
	)
}
