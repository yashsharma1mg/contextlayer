import { generateText } from "ai"
import { openrouter, withModelFallback } from "./openrouter"
import type { SearchResult } from "./search"

const SYSTEM_PROMPT = `You generate a single, complete, self-contained HTML file for a UI mockup.

Rules:
- One file only: <!DOCTYPE html> through </html>. No external scripts, stylesheets, fonts, images, network requests, or fetch calls.
- Put all CSS in one <style> block in <head>. Use clean system fonts and responsive CSS.
- Use realistic placeholder content that matches the prompt's domain — never lorem ipsum.
- No JavaScript beyond what's needed for basic interactivity (tabs, toggles). No external JS libraries, no fetch calls.
- Output ONLY the HTML. No markdown fences, no explanation before or after.`

/**
 * Prompt -> a complete offline HTML prototype. The no-network contract lets
 * Studio render it inside a sandbox without giving generated code access to
 * the user's session, product, or connector data.
 */
export async function generateUi(
	prompt: string,
	grounding: SearchResult[],
	designAssets: { name: string; description: string | null }[] = [],
): Promise<string> {
	const context =
		grounding.length > 0
			? `\n\nRelevant team context to ground the design in:\n${grounding
					.map((s) => `- ${s.title}: ${s.chunkContent.slice(0, 300)}`)
					.join("\n")}`
			: ""
	const designContext = designAssets.length
		? `\n\nApproved design-system assets to reflect in the interface:\n${designAssets
				.map(
					(asset) =>
						`- ${asset.name}${asset.description ? `: ${asset.description}` : ""}`,
				)
				.join("\n")}`
		: ""

	const { text } = await withModelFallback((model) =>
		generateText({
			model: openrouter.chat(model),
			system: SYSTEM_PROMPT,
			prompt: `${prompt}${context}${designContext}`,
		}),
	)

	// Models occasionally wrap output in fences despite instructions —
	// salvage rather than fail, since regeneration costs a full LLM call.
	const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/)
	const html = (fenced?.[1] ?? text).trim()
	if (!html.toLowerCase().includes("<html")) {
		throw new Error(
			"Model did not return an HTML document; try rephrasing the prompt",
		)
	}
	return html
}
