export function redactCaptureOutline(raw: string) {
	try {
		const containsSensitiveNode = (value: unknown): boolean => {
			if (Array.isArray(value)) return value.some(containsSensitiveNode)
			if (!value || typeof value !== "object") return false
			const record = value as Record<string, unknown>
			return (
				record.redacted === true ||
				["input", "textarea", "select"].includes(String(record.tag)) ||
				containsSensitiveNode(record.children)
			)
		}
		const scrub = (value: unknown, key = ""): unknown => {
			if (
				/password|cookie|authorization|token|secret|storage|value/i.test(key)
			) {
				return "[REDACTED]"
			}
			if (Array.isArray(value)) return value.map((item) => scrub(item))
			if (value && typeof value === "object") {
				const record = value as Record<string, unknown>
				const sensitiveNode =
					record.redacted === true ||
					["input", "textarea", "select"].includes(String(record.tag))
				const scrubbed = Object.fromEntries(
					Object.entries(value).map(([childKey, child]) => [
						childKey,
						scrub(child, childKey),
					]),
				)
				const sensitiveDescendant = containsSensitiveNode(scrubbed.children)
				if (sensitiveNode || sensitiveDescendant) delete scrubbed.text
				return scrubbed
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

export function captureOutlineText(raw: string) {
	try {
		const output: string[] = []
		const visit = (value: unknown) => {
			if (Array.isArray(value)) {
				for (const item of value) visit(item)
				return
			}
			if (!value || typeof value !== "object") return
			const record = value as Record<string, unknown>
			if (record.redacted !== true) {
				for (const key of ["text", "label", "role"] as const) {
					const text = record[key]
					if (typeof text === "string" && text.trim()) output.push(text.trim())
				}
			}
			visit(record.children)
			visit(record.root)
		}
		visit(JSON.parse(raw))
		return [...new Set(output)].join("\n")
	} catch {
		return ""
	}
}
