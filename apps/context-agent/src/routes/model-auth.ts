/**
 * Model provider accounts — which account this machine talks to.
 *
 * Keys only, for every provider. Neither Anthropic nor OpenAI offers a sign-in
 * that authorizes a third-party app to spend a consumer subscription —
 * Anthropic blocks subscription OAuth outside its own clients, and "Sign in
 * with ChatGPT" grants identity, not inference. Anything reachable here is
 * billed as API usage, so a key is the whole story.
 *
 * Never returns secret material. Keys go in one direction only.
 */

import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { requireCaller } from "../lib/caller"
import {
	clearCredential,
	hasCredential,
	isCredentialProvider,
	storeCredential,
	type CredentialProvider,
} from "../lib/model-credentials"
import { discoverOpenAiKey, maskKey } from "../lib/openai-key-discovery"
import { canManageOrganization } from "../lib/organization-access"

export const modelAuthRoute = new Hono()

/** Model credentials are machine-wide, so changing one affects every member of
 * the organization. Same bar as the other destructive privacy operations. */
async function requireOwner(c: Parameters<typeof requireCaller>[0]) {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		throw new HTTPException(403, { message: "Owner access required" })
	}
	return caller
}

function envVar(provider: CredentialProvider) {
	return provider === "anthropic"
		? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
		: provider === "openai"
			? Boolean(process.env.OPENAI_API_KEY)
			: Boolean(process.env.OPENROUTER_API_KEY)
}

function sourceOf(provider: CredentialProvider) {
	if (envVar(provider)) return "env" as const
	if (hasCredential(provider)) return "stored" as const
	return null
}

modelAuthRoute.get("/", async (c) => {
	await requireCaller(c)
	return c.json({
		anthropic: { source: sourceOf("anthropic") },
		openai: { source: sourceOf("openai") },
		openrouter: { source: sourceOf("openrouter") },
	})
})

/**
 * Validates a key against the provider before storing it, so a typo fails here
 * with the provider's own message rather than silently at generation time.
 */
async function validateKey(provider: CredentialProvider, key: string) {
	const request =
		provider === "anthropic"
			? new Request("https://api.anthropic.com/v1/models", {
					headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
				})
			: new Request(
					provider === "openai"
						? "https://api.openai.com/v1/models"
						: "https://openrouter.ai/api/v1/models",
					{ headers: { authorization: `Bearer ${key}` } },
				)
	let response: Response
	try {
		response = await fetch(request)
	} catch (error) {
		throw new HTTPException(502, {
			message: `Could not reach ${provider}: ${(error as Error).message}`,
		})
	}
	if (response.ok) return
	const body = await response.text()
	let detail = body.slice(0, 300)
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } }
		if (parsed.error?.message) detail = parsed.error.message
	} catch {
		// Non-JSON error body; the raw text is the best we have.
	}
	throw new HTTPException(400, {
		message: `${provider} rejected the key: ${detail}`,
	})
}

modelAuthRoute.put(
	"/:provider/key",
	zValidator("json", z.object({ key: z.string().min(8).max(512) })),
	async (c) => {
		await requireOwner(c)
		const provider = c.req.param("provider")
		if (!isCredentialProvider(provider)) {
			return c.json({ error: "Unknown provider" }, 400)
		}
		const key = c.req.valid("json").key.trim()
		await validateKey(provider, key)
		storeCredential(provider, key)
		return c.json({ source: sourceOf(provider) })
	},
)

modelAuthRoute.delete("/:provider", async (c) => {
	await requireOwner(c)
	const provider = c.req.param("provider")
	if (!isCredentialProvider(provider)) {
		return c.json({ error: "Unknown provider" }, 400)
	}
	clearCredential(provider)
	return c.json({ source: sourceOf(provider) })
})

/**
 * An OpenAI key the user already has, offered for import so they do not have to
 * find and paste it.
 *
 * Reads ~/.codex/auth.json **only** in `apikey` mode. In `chatgpt` mode that
 * file holds subscription tokens belonging to Codex's OAuth client; using those
 * here would be spending plan quota outside the product it was sold for.
 */
modelAuthRoute.get("/openai/detect", async (c) => {
	await requireOwner(c)
	const found = discoverOpenAiKey()
	return c.json(
		found
			? { found: true, origin: found.origin, preview: maskKey(found.key) }
			: { found: false },
	)
})

modelAuthRoute.post("/openai/import", async (c) => {
	await requireOwner(c)
	const found = discoverOpenAiKey()
	if (!found) return c.json({ error: "No importable key found" }, 404)
	await validateKey("openai", found.key)
	storeCredential("openai", found.key)
	return c.json({ source: sourceOf("openai") })
})
