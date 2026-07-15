const CHUNK_SIZE = 1200
const CHUNK_OVERLAP = 150

export function chunkText(text: string): string[] {
	const blocks = text
		.replace(/\r\n/g, "\n")
		.split(/\n{2,}|(?=^#{1,6}\s)|(?=^[-*]\s)/m)
		.map((block) => block.trim())
		.filter(Boolean)
	if (!blocks.length) return []

	const chunks: string[] = []
	let current = ""
	const flush = () => {
		if (!current) return
		chunks.push(current)
		current = current.slice(-CHUNK_OVERLAP).trim()
	}
	for (const block of blocks) {
		if (block.length > CHUNK_SIZE) {
			if (current) flush()
			let start = 0
			while (start < block.length) {
				const target = Math.min(start + CHUNK_SIZE, block.length)
				const boundary =
					target === block.length
						? target
						: Math.max(
								block.lastIndexOf(". ", target),
								block.lastIndexOf("\n", target),
								start + Math.floor(CHUNK_SIZE * 0.7),
							)
				chunks.push(block.slice(start, boundary).trim())
				if (boundary === block.length) break
				start = Math.max(start + 1, boundary - CHUNK_OVERLAP)
			}
			current = ""
			continue
		}
		const candidate = current ? `${current}\n\n${block}` : block
		if (candidate.length > CHUNK_SIZE) flush()
		current = current ? `${current}\n\n${block}` : block
	}
	if (current) chunks.push(current)
	return chunks.filter(Boolean)
}
