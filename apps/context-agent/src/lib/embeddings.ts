/**
 * Embedding provider resolution.
 *
 * All supported providers expose the same OpenAI-shaped `POST /embeddings`
 * contract — `{input, model}` in, `{data: [{embedding}]}` out — so there is one
 * request path with a couple of per-provider fields rather than an adapter each.
 *
 * Selection mirrors providers.ts: LOCAL_EMBED_BASE_URL has no default, so an
 * install that only has NVIDIA_API_KEY keeps resolving to NVIDIA as before.
 */

/** Must match vector(EMBEDDING_DIMENSIONS) in packages/db/src/schema/memory.ts. */
export const EMBEDDING_DIMENSIONS = 1024

export type EmbedProviderId = "local" | "nvidia" | "openai"

interface EmbedProvider {
	configured: () => boolean
	url: () => string
	apiKey: () => string | undefined
	model: () => string
	/** False for providers that run on the user's own machine. */
	remote: boolean
	/** Provider-specific body fields. */
	extraBody?: (inputType: "query" | "passage") => Record<string, unknown>
}

const EMBED_PROVIDERS: Record<EmbedProviderId, EmbedProvider> = {
	local: {
		configured: () => Boolean(process.env.LOCAL_EMBED_BASE_URL),
		url: () => `${trimSlash(process.env.LOCAL_EMBED_BASE_URL)}/embeddings`,
		apiKey: () => process.env.LOCAL_EMBED_API_KEY ?? "local",
		// mxbai-embed-large emits 1024 dimensions, matching the column. Most
		// other local defaults do not — nomic-embed-text is 768.
		model: () => process.env.LOCAL_EMBED_MODEL ?? "mxbai-embed-large",
		remote: false,
	},
	nvidia: {
		configured: () => Boolean(process.env.NVIDIA_API_KEY),
		url: () => "https://integrate.api.nvidia.com/v1/embeddings",
		apiKey: () => process.env.NVIDIA_API_KEY,
		model: () => process.env.NVIDIA_EMBED_MODEL ?? "nvidia/nv-embedqa-e5-v5",
		remote: true,
		// e5-style asymmetric model: query and passage inputs must declare which
		// they are or retrieval quality degrades.
		extraBody: (inputType) => ({ input_type: inputType }),
	},
	openai: {
		configured: () => Boolean(process.env.OPENAI_API_KEY),
		url: () => "https://api.openai.com/v1/embeddings",
		apiKey: () => process.env.OPENAI_API_KEY,
		model: () => process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-large",
		remote: true,
		// text-embedding-3-* are natively larger; ask for a truncated vector so
		// the result fits the column.
		extraBody: () => ({ dimensions: EMBEDDING_DIMENSIONS }),
	},
}

const EMBED_PRIORITY: EmbedProviderId[] = ["local", "nvidia", "openai"]

function trimSlash(url: string | undefined) {
	return (url ?? "").replace(/\/+$/, "")
}

/** Which provider embedding will actually use. Drives consent checks. */
export function activeEmbedProvider(): EmbedProviderId | null {
	const explicit = process.env.EMBED_PROVIDER as EmbedProviderId | undefined
	if (explicit) {
		if (!EMBED_PROVIDERS[explicit]) {
			throw new Error(
				`Unknown EMBED_PROVIDER "${explicit}". Expected one of: ${Object.keys(EMBED_PROVIDERS).join(", ")}`,
			)
		}
		return explicit
	}
	// Null rather than throwing: search degrades to lexical-only when no
	// embedding provider is configured, which is a supported state.
	return EMBED_PRIORITY.find((id) => EMBED_PROVIDERS[id].configured()) ?? null
}

/** True when the active embedding provider sends content off the machine. */
export function embedProviderIsRemote(): boolean {
	const id = activeEmbedProvider()
	return id ? EMBED_PROVIDERS[id].remote : false
}

async function embed(
	texts: string[],
	inputType: "query" | "passage",
): Promise<number[][]> {
	const id = activeEmbedProvider()
	if (!id) {
		throw new Error(
			"No embedding provider configured. Set one of LOCAL_EMBED_BASE_URL, NVIDIA_API_KEY, or OPENAI_API_KEY.",
		)
	}
	const provider = EMBED_PROVIDERS[id]
	const model = provider.model()

	const res = await fetch(provider.url(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${provider.apiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			input: texts,
			model,
			encoding_format: "float",
			...provider.extraBody?.(inputType),
		}),
	})
	if (!res.ok) {
		throw new Error(
			`Embeddings request to ${id} failed: ${res.status} ${await res.text()}`,
		)
	}
	const data = (await res.json()) as { data: { embedding: number[] }[] }
	const vectors = data.data.map((d) => d.embedding)

	// A wrong-sized vector is rejected by Postgres with an opaque type error on
	// insert, and silently breaks search on query. Fail here with the model name
	// instead, since picking a model of the wrong width is the usual cause.
	const wrong = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS)
	if (wrong) {
		throw new Error(
			`Embedding model ${model} (${id}) returned ${wrong.length} dimensions, but the database column is vector(${EMBEDDING_DIMENSIONS}). Choose a model of matching width.`,
		)
	}
	return vectors
}

// Asymmetric models need query and passage inputs tagged differently, so two
// named entry points instead of one that could be called with the wrong type.
export const embedQuery = (text: string) =>
	embed([text], "query").then((r) => r[0] as number[])

export const embedPassages = (texts: string[]) => embed(texts, "passage")
