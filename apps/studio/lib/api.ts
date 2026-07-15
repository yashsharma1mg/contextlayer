export const API_URL =
	process.env.NEXT_PUBLIC_API_URL ??
	(typeof window !== "undefined" && window.location.port === "31420"
		? "http://127.0.0.1:31421"
		: "http://localhost:8787")

export type ApiJob = {
	id: string
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
	progress: number
	result: Record<string, unknown> | null
	error: string | null
}

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
	method: "POST" | "PUT" | "PATCH",
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

export async function waitForJob(
	id: string,
	onProgress?: (job: ApiJob) => void,
) {
	const deadline = Date.now() + 30 * 60_000
	while (Date.now() < deadline) {
		const { job } = await apiGet<{ job: ApiJob }>(`/api/jobs/${id}`)
		onProgress?.(job)
		if (job.status === "succeeded") return job
		if (job.status === "failed" || job.status === "cancelled") {
			throw new Error(job.error || `Job ${job.status}`)
		}
		await new Promise((resolve) => setTimeout(resolve, 750))
	}
	throw new Error("Background job timed out")
}
