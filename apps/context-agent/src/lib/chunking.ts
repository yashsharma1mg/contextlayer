const CHUNK_SIZE = 1200
const CHUNK_OVERLAP = 150

/**
 * Naive fixed-size chunker with overlap. Good enough for MVP; the plan flags
 * Confluence's ADF (structured JSON) as preferable to HTML-ish storage format
 * specifically so a smarter, structure-aware chunker can replace this later
 * without changing anything downstream (chunks are just `content: string`).
 */
export function chunkText(text: string): string[] {
	const clean = text.trim()
	if (clean.length <= CHUNK_SIZE) return clean.length ? [clean] : []

	const chunks: string[] = []
	let start = 0
	while (start < clean.length) {
		const end = Math.min(start + CHUNK_SIZE, clean.length)
		chunks.push(clean.slice(start, end))
		if (end === clean.length) break
		start = end - CHUNK_OVERLAP
	}
	return chunks
}
