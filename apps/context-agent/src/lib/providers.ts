import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"

/**
 * Chat/generation provider resolution.
 *
 * Everything except Anthropic speaks the OpenAI wire format, so one
 * `createOpenAI` factory pointed at a different base URL covers OpenRouter,
 * OpenAI itself, and any local OpenAI-compatible server (Ollama, opencode,
 * llama.cpp, LM Studio). Anthropic needs its own factory because its wire
 * format differs.
 *
 * Selection order is deliberate: an explicit CHAT_PROVIDER always wins, then
 * local if it has been pointed somewhere, then cloud keys in order. LOCAL_CHAT_BASE_URL
 * intentionally has no default — without one, an install that only has
 * OPENROUTER_API_KEY set keeps resolving to OpenRouter exactly as before.
 */
export type ChatProviderId = "anthropic" | "openai" | "openrouter" | "local"

interface ChatProvider {
	/** Whether the environment has enough configuration to use this provider. */
	configured: () => boolean
	model: () => LanguageModel
	/** Model slug used when no explicit override is set. */
	defaultModel: string
	/** False for providers that run on the user's own machine. */
	remote: boolean
}

/**
 * Anthropic accepts either an API key (`x-api-key`) or an OAuth access token
 * (`Authorization: Bearer` plus the oauth beta header). They are mutually
 * exclusive — sending both is rejected — so the OAuth path strips the API-key
 * header the SDK would otherwise attach.
 */
function anthropicModel(): LanguageModel {
	const oauthToken = process.env.ANTHROPIC_AUTH_TOKEN
	const model = process.env.ANTHROPIC_CHAT_MODEL ?? "claude-opus-5"

	if (!oauthToken) {
		return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(model)
	}

	return createAnthropic({
		// Non-empty placeholder: the SDK requires a key to construct, and the
		// fetch wrapper below removes the header it produces.
		apiKey: "oauth",
		headers: {
			authorization: `Bearer ${oauthToken}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		// Cast because Bun types `fetch` with a non-standard `preconnect` static
		// that the SDK never calls; the call signature itself matches.
		fetch: ((
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const headers = new Headers(init?.headers)
			headers.delete("x-api-key")
			return fetch(input, { ...init, headers })
		}) as typeof fetch,
	})(model)
}

function openAiCompatible(
	baseURL: string | undefined,
	apiKey: string | undefined,
) {
	return createOpenAI({ baseURL, apiKey })
}

const CHAT_PROVIDERS: Record<ChatProviderId, ChatProvider> = {
	local: {
		configured: () => Boolean(process.env.LOCAL_CHAT_BASE_URL),
		defaultModel: process.env.LOCAL_CHAT_MODEL ?? "qwen2.5-coder",
		remote: false,
		model: () =>
			openAiCompatible(
				process.env.LOCAL_CHAT_BASE_URL,
				// Ollama ignores the key but the SDK requires one to be present.
				process.env.LOCAL_CHAT_API_KEY ?? "local",
			).chat(process.env.LOCAL_CHAT_MODEL ?? "qwen2.5-coder"),
	},
	anthropic: {
		configured: () =>
			Boolean(
				process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
			),
		defaultModel: process.env.ANTHROPIC_CHAT_MODEL ?? "claude-opus-5",
		remote: true,
		model: anthropicModel,
	},
	openai: {
		configured: () => Boolean(process.env.OPENAI_API_KEY),
		defaultModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-5.2",
		remote: true,
		model: () =>
			openAiCompatible(undefined, process.env.OPENAI_API_KEY).chat(
				process.env.OPENAI_CHAT_MODEL ?? "gpt-5.2",
			),
	},
	openrouter: {
		configured: () => Boolean(process.env.OPENROUTER_API_KEY),
		defaultModel:
			process.env.OPENROUTER_CHAT_MODEL ??
			"nvidia/nemotron-3-ultra-550b-a55b:free",
		remote: true,
		model: () =>
			openAiCompatible(
				"https://openrouter.ai/api/v1",
				process.env.OPENROUTER_API_KEY,
			).chat(
				process.env.OPENROUTER_CHAT_MODEL ??
					"nvidia/nemotron-3-ultra-550b-a55b:free",
			),
	},
}

const CHAT_PRIORITY: ChatProviderId[] = [
	"local",
	"anthropic",
	"openai",
	"openrouter",
]

/**
 * Which provider generation would use, or null if none is configured.
 * Non-throwing so callers that treat generation as optional (chunk filtering,
 * for instance) can just skip it.
 */
export function resolveChatProvider(): ChatProviderId | null {
	const explicit = process.env.CHAT_PROVIDER as ChatProviderId | undefined
	if (explicit) {
		if (!CHAT_PROVIDERS[explicit]) {
			throw new Error(
				`Unknown CHAT_PROVIDER "${explicit}". Expected one of: ${Object.keys(CHAT_PROVIDERS).join(", ")}`,
			)
		}
		return explicit
	}
	return CHAT_PRIORITY.find((id) => CHAT_PROVIDERS[id].configured()) ?? null
}

/** Which provider generation will actually use. Drives consent checks. */
export function activeChatProvider(): ChatProviderId {
	const found = resolveChatProvider()
	if (!found) {
		throw new Error(
			"No chat provider configured. Set one of LOCAL_CHAT_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, or OPENROUTER_API_KEY.",
		)
	}
	return found
}

/** True when the active chat provider sends content off the machine. */
export function chatProviderIsRemote(): boolean {
	const id = resolveChatProvider()
	return id ? CHAT_PROVIDERS[id].remote : false
}

const MAX_CONCURRENT_MODEL_REQUESTS = Math.max(
	1,
	Number(process.env.MODEL_CONCURRENCY) || 2,
)
let activeModelRequests = 0

/**
 * Runs a generation against the active provider's model, retrying once on the
 * fallback model if one is configured. Free OpenRouter slugs get rate-limited
 * and retired without notice, which is why the retry exists; it applies to
 * every provider now rather than just OpenRouter.
 *
 * Callers pass a closure so this works for generateText and generateObject
 * alike, and receive a ready LanguageModel rather than a slug — the call site
 * never needs to know which provider is in play.
 */
export async function withModelFallback<T>(
	run: (model: LanguageModel) => Promise<T>,
): Promise<T> {
	if (activeModelRequests >= MAX_CONCURRENT_MODEL_REQUESTS) {
		throw new Error("Generation is busy. Try again in a moment.")
	}
	activeModelRequests += 1
	const providerId = activeChatProvider()
	const provider = CHAT_PROVIDERS[providerId]
	try {
		return await run(provider.model())
	} catch (e) {
		const fallback = process.env.CHAT_FALLBACK_MODEL
		if (!fallback || fallback === provider.defaultModel) throw e
		console.error(
			`Model ${provider.defaultModel} on ${providerId} failed, retrying with ${fallback}:`,
			e,
		)
		// Fallback stays on the same provider — a slug is only meaningful to
		// the provider it came from.
		return await run(fallbackModel(providerId, fallback))
	} finally {
		activeModelRequests -= 1
	}
}

function fallbackModel(
	providerId: ChatProviderId,
	slug: string,
): LanguageModel {
	switch (providerId) {
		case "anthropic":
			return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(slug)
		case "openai":
			return openAiCompatible(undefined, process.env.OPENAI_API_KEY).chat(slug)
		case "openrouter":
			return openAiCompatible(
				"https://openrouter.ai/api/v1",
				process.env.OPENROUTER_API_KEY,
			).chat(slug)
		case "local":
			return openAiCompatible(
				process.env.LOCAL_CHAT_BASE_URL,
				process.env.LOCAL_CHAT_API_KEY ?? "local",
			).chat(slug)
	}
}
