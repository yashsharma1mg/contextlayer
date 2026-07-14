const NVIDIA_EMBED_URL = "https://integrate.api.nvidia.com/v1/embeddings"
const EMBED_MODEL = "nvidia/nv-embedqa-e5-v5"

// Matches vector(1024) in packages/db/src/schema/memory.ts.
async function embed(
	texts: string[],
	inputType: "query" | "passage",
): Promise<number[][]> {
	const res = await fetch(NVIDIA_EMBED_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			input: texts,
			model: EMBED_MODEL,
			input_type: inputType,
			encoding_format: "float",
		}),
	})
	if (!res.ok) {
		throw new Error(
			`NVIDIA embeddings request failed: ${res.status} ${await res.text()}`,
		)
	}
	const data = (await res.json()) as { data: { embedding: number[] }[] }
	return data.data.map((d) => d.embedding)
}

// e5-style asymmetric embedding model: query/passage inputs must use the
// matching input_type or retrieval quality degrades, so two named entry
// points instead of one that could be called with the wrong one.
export const embedQuery = (text: string) =>
	embed([text], "query").then((r) => r[0] as number[])

export const embedPassages = (texts: string[]) => embed(texts, "passage")
