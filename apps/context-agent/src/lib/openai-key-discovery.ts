/**
 * Finds an OpenAI key the user already has on this machine, so connecting does
 * not require hunting one down and pasting it.
 *
 * The security boundary here is `auth_mode`. In `chatgpt` mode, ~/.codex/auth.json
 * holds OAuth tokens issued to Codex's own client against the user's ChatGPT
 * plan. Those are not API keys, they are not ours to spend, and using them here
 * would be spending a subscription outside the product it was sold for — the
 * same thing Anthropic banned for Claude subscriptions. Only an actual platform
 * key, which Codex stores in `apikey` mode, is importable.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface DiscoveredKey {
	key: string
	origin: string
}

export function codexAuthPath() {
	return join(homedir(), ".codex", "auth.json")
}

export function discoverOpenAiKey(
	codexPath = codexAuthPath(),
): DiscoveredKey | null {
	const fromEnv = process.env.OPENAI_API_KEY
	if (fromEnv) return { key: fromEnv, origin: "OPENAI_API_KEY" }
	try {
		const parsed = JSON.parse(readFileSync(codexPath, "utf8")) as {
			auth_mode?: string
			OPENAI_API_KEY?: string | null
		}
		// Anything that is not explicitly an API-key install is refused, so an
		// unrecognised or future mode fails closed rather than open.
		if (parsed.auth_mode !== "apikey") return null
		if (parsed.OPENAI_API_KEY) {
			return { key: parsed.OPENAI_API_KEY, origin: "~/.codex/auth.json" }
		}
	} catch {
		// No Codex install, or a shape we do not recognise.
	}
	return null
}

/** Enough to recognise a key without revealing it. */
export function maskKey(key: string) {
	return `${key.slice(0, 3)}…${key.slice(-4)}`
}
