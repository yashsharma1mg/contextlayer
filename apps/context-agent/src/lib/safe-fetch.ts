import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const parts = address.split(".").map(Number)
		const [a = 0, b = 0] = parts
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		)
	}
	if (isIP(address) === 6) {
		const normalized = address.toLowerCase()
		const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
		return (
			(mapped ? isPrivateAddress(mapped) : false) ||
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith("::ffff:127.")
		)
	}
	return true
}

export async function assertPublicHttpUrl(value: string) {
	const url = new URL(value)
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Only HTTP and HTTPS URLs are supported")
	}
	if (url.username || url.password)
		throw new Error("URL credentials are blocked")
	if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
		throw new Error("Private-network URLs are blocked")
	}
	const addresses = await lookup(url.hostname, { all: true, verbatim: true })
	if (
		!addresses.length ||
		addresses.some(({ address }) => isPrivateAddress(address))
	) {
		throw new Error("Private-network URLs are blocked")
	}
	return url
}

export async function safeFetchText(
	value: string,
	maxBytes = 10 * 1024 * 1024,
	signal?: AbortSignal,
) {
	let url = await assertPublicHttpUrl(value)
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		const response = await fetch(url, {
			redirect: "manual",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
				: AbortSignal.timeout(20_000),
			headers: { "User-Agent": "ContextLayer/0.1 knowledge-import" },
		})
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location")
			if (!location) throw new Error("Redirect did not include a location")
			url = await assertPublicHttpUrl(new URL(location, url).toString())
			continue
		}
		if (!response.ok) throw new Error(`URL import failed (${response.status})`)
		const contentLength = Number(response.headers.get("content-length") ?? "0")
		if (contentLength > maxBytes) throw new Error("URL content exceeds 10 MB")
		if (!response.body) throw new Error("URL returned no content")
		const chunks: Uint8Array[] = []
		let size = 0
		for await (const chunk of response.body) {
			size += chunk.byteLength
			if (size > maxBytes) throw new Error("URL content exceeds 10 MB")
			chunks.push(chunk)
		}
		const data = Buffer.concat(chunks)
		return {
			url: url.toString(),
			data,
			contentType:
				response.headers.get("content-type")?.split(";")[0] ?? "text/html",
		}
	}
	throw new Error("URL exceeded the redirect limit")
}
