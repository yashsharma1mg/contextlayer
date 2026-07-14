import { createOpenAI } from "@ai-sdk/openai"

// OpenRouter is OpenAI-compatible, so the existing @ai-sdk/openai package
// works unmodified pointed at OpenRouter's base URL — no new dependency.
// Shared by chat.ts (RAG answers) and understand.ts (signal/noise filtering)
// so there's one client and one model default, not two.
export const openrouter = createOpenAI({
	baseURL: "https://openrouter.ai/api/v1",
	apiKey: process.env.OPENROUTER_API_KEY,
})

// Swappable via OPENROUTER_CHAT_MODEL; verify current slug at
// openrouter.ai/models if this one has been retired.
export const DEFAULT_MODEL =
	process.env.OPENROUTER_CHAT_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free"

const MAX_CONCURRENT_MODEL_REQUESTS = Math.max(
	1,
	Number(process.env.MODEL_CONCURRENCY) || 2,
)
let activeModelRequests = 0

/**
 * Free OpenRouter slugs get rate-limited and retired without notice — run
 * the call against the primary model, and on failure retry once with
 * OPENROUTER_FALLBACK_MODEL if configured. Callers pass a closure so this
 * works for generateText and generateObject alike.
 */
export async function withModelFallback<T>(
	run: (modelSlug: string) => Promise<T>,
): Promise<T> {
	if (activeModelRequests >= MAX_CONCURRENT_MODEL_REQUESTS) {
		throw new Error("Generation is busy. Try again in a moment.")
	}
	activeModelRequests += 1
	try {
		return await run(DEFAULT_MODEL)
	} catch (e) {
		const fallback = process.env.OPENROUTER_FALLBACK_MODEL
		if (!fallback || fallback === DEFAULT_MODEL) throw e
		console.error(
			`Model ${DEFAULT_MODEL} failed, retrying with ${fallback}:`,
			e,
		)
		return await run(fallback)
	} finally {
		activeModelRequests -= 1
	}
}
