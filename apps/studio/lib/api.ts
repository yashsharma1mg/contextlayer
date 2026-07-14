export const API_URL =
	process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"

export async function apiGet<T>(
	path: string,
	query?: Record<string, string | number | undefined>,
): Promise<T> {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) params.set(key, String(value))
	}
	const suffix = params.size > 0 ? `?${params}` : ""
	const res = await fetch(`${API_URL}${path}${suffix}`, {
		credentials: "include",
	})
	if (!res.ok) {
		const err = await res.json().catch(() => null)
		throw new Error(err?.error ?? `${path} failed: ${res.status}`)
	}
	return res.json()
}

export async function apiSend<T>(
	method: "POST" | "PATCH",
	path: string,
	body: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(`${API_URL}${path}`, {
		method,
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		const err = await res.json().catch(() => null)
		throw new Error(err?.error ?? `${path} failed: ${res.status}`)
	}
	return res.json()
}

export async function apiDelete<T>(path: string): Promise<T> {
	const res = await fetch(`${API_URL}${path}`, {
		method: "DELETE",
		credentials: "include",
	})
	if (!res.ok) {
		const err = await res.json().catch(() => null)
		throw new Error(err?.error ?? `${path} failed: ${res.status}`)
	}
	return res.json()
}
