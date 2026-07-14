export function redactCaptureOutline(raw: string) {
	try {
		const scrub = (value: unknown, key = ""): unknown => {
			if (
				/password|cookie|authorization|token|secret|storage|value/i.test(key)
			) {
				return "[REDACTED]"
			}
			if (Array.isArray(value)) return value.map((item) => scrub(item))
			if (value && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value).map(([childKey, child]) => [
						childKey,
						scrub(child, childKey),
					]),
				)
			}
			return value
		}
		return JSON.stringify(scrub(JSON.parse(raw)))
	} catch {
		return raw.replace(
			/(password|cookie|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi,
			"$1=[REDACTED]",
		)
	}
}
