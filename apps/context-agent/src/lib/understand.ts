import { generateObject } from "ai"
import { z } from "zod"
import { openrouter, withModelFallback } from "./openrouter"

const classificationSchema = z.object({
	chunks: z.array(z.object({ index: z.number(), signal: z.boolean() })),
})

/**
 * The "understanding" pass that sits beside embedding, inspired by
 * Understand-Anything's deterministic-layer + LLM-semantic-layer split
 * (there: tree-sitter facts + LLM intent for code; here: chunking facts +
 * LLM relevance for documents). Before anything gets embedded, one batched
 * LLM call classifies each chunk as signal (real, useful content) or noise
 * (boilerplate, nav text, empty filler, near-duplicate of another chunk) —
 * source-agnostic, so it applies uniformly whether content came from
 * Confluence, Figma, or a raw upload.
 */
export async function signalChunkIndexes(chunks: string[]): Promise<number[]> {
	if (chunks.length <= 1) return chunks.map((_, index) => index)

	const numbered = chunks
		.map((c, i) => `[${i}] ${c.slice(0, 800)}`)
		.join("\n\n")

	try {
		const { object } = await withModelFallback((model) =>
			generateObject({
				model: openrouter.chat(model),
				schema: classificationSchema,
				system:
					"You are a signal-vs-noise filter for a knowledge base ingestion pipeline. For each numbered chunk, decide whether it contains real, useful information (signal) or is boilerplate, navigation text, empty filler, or a near-duplicate of another chunk (noise). Err toward keeping content when uncertain — only mark something noise if it's clearly not worth anyone searching for.",
				prompt: numbered,
			}),
		)
		const signalByIndex = new Map(object.chunks.map((c) => [c.index, c.signal]))
		const kept = chunks
			.map((_, index) => index)
			.filter((index) => signalByIndex.get(index) ?? true)
		// Never let the filter zero out a whole document — that's a sign the
		// call misbehaved, not that everything was actually noise.
		return kept.length > 0 ? kept : chunks.map((_, index) => index)
	} catch (e) {
		// Classification is a quality optimization, not a correctness
		// requirement — a failed call should never mean lost content.
		console.error("Signal/noise classification failed, keeping all chunks:", e)
		return chunks.map((_, index) => index)
	}
}

export async function filterSignal(chunks: string[]): Promise<string[]> {
	const indexes = await signalChunkIndexes(chunks)
	return indexes.map((index) => chunks[index] as string)
}
