export const API_URL =
	process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"

export interface Caller {
	orgId: string
	userId: string
	teamIds?: string[]
}

export async function apiGet<T>(path: string, caller: Caller): Promise<T> {
	const params = new URLSearchParams({
		orgId: caller.orgId,
		userId: caller.userId,
	})
	for (const t of caller.teamIds ?? []) params.append("teamIds", t)
	const res = await fetch(`${API_URL}${path}?${params}`)
	if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
	return res.json()
}

export async function apiSend<T>(
	method: "POST" | "PATCH",
	path: string,
	body: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(`${API_URL}${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		const err = await res.json().catch(() => null)
		throw new Error(err?.error ?? `${path} failed: ${res.status}`)
	}
	return res.json()
}
