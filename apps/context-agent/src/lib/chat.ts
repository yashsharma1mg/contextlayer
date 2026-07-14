import { generateText } from "ai"
import { openrouter, withModelFallback } from "./openrouter"
import { provenanceLabel, type SearchResult } from "./search"

export async function answerFromContext(
	question: string,
	sources: SearchResult[],
): Promise<string> {
	const context = sources
		.map((s, i) => {
			const location = provenanceLabel(s.chunkProvenance)
			return `[${i + 1}] ${s.title}${location ? `, ${location}` : ""}${s.url ? ` (${s.url})` : ""}\n${s.chunkContent}`
		})
		.join("\n\n")

	// OpenRouter only implements the Chat Completions API, not OpenAI's newer
	// Responses API that @ai-sdk/openai defaults to — .chat() forces the former.
	const { text } = await withModelFallback((model) =>
		generateText({
			model: openrouter.chat(model),
			system:
				"Answer the question using only the provided context. Cite sources by their [n] marker. If the context doesn't contain the answer, say so plainly.",
			prompt: `Context:\n${context}\n\nQuestion: ${question}`,
		}),
	)

	return text
}
