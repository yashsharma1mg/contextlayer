"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { authClient, signIn, signUp } from "@/lib/auth-client"

export default function LoginPage() {
	const router = useRouter()
	const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in")
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [name, setName] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setLoading(true)
		const { error: authError } =
			mode === "sign-in"
				? await signIn.email({ email, password })
				: await signUp.email({ email, password, name })
		setLoading(false)
		if (authError) {
			setError(authError.message ?? "Something went wrong")
			return
		}
		if (window.location.search.includes("sig=")) {
			const continuation = await authClient.oauth2.continue({})
			if (continuation.error) {
				setError(
					continuation.error.message ?? "Could not continue authorization",
				)
				return
			}
			if (continuation.data?.url) {
				window.location.assign(continuation.data.url)
				return
			}
		}
		router.push("/")
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<form
				onSubmit={handleSubmit}
				className="w-full max-w-sm space-y-4 rounded-[var(--radius-lg)] border border-border bg-card p-6"
			>
				<div className="space-y-1">
					<h1 className="text-lg font-medium text-foreground">
						{mode === "sign-in" ? "Sign in" : "Create an account"}
					</h1>
					<p className="text-sm text-muted-foreground">Context Layer</p>
				</div>

				{mode === "sign-up" && (
					<Input
						placeholder="Name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
					/>
				)}
				<Input
					type="email"
					placeholder="Email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
				<Input
					type="password"
					placeholder="Password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>

				{error && <p className="text-sm text-destructive">{error}</p>}

				<Button type="submit" disabled={loading} className="w-full">
					{loading ? "..." : mode === "sign-in" ? "Sign in" : "Sign up"}
				</Button>

				<button
					type="button"
					onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
					className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
				>
					{mode === "sign-in"
						? "Need an account? Sign up"
						: "Already have an account? Sign in"}
				</button>
			</form>
		</div>
	)
}
