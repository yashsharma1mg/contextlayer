import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activeEmbedProvider, embedProviderIsRemote } from "./embeddings"
import { resetCredentialCache, storeCredential } from "./model-credentials"
import {
	anthropicCredential,
	chatProviderIsRemote,
	resolveChatProvider,
	type ChatProviderId,
} from "./providers"

const MODEL_ENV = [
	"CHAT_PROVIDER",
	"EMBED_PROVIDER",
	"LOCAL_CHAT_BASE_URL",
	"LOCAL_EMBED_BASE_URL",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"NVIDIA_API_KEY",
	// Redirected at a scratch directory below: without it, a developer machine
	// with a populated data directory would make "nothing is configured"
	// quietly false.
	"CONTEXT_LAYER_DATA_DIR",
	"CONNECTION_ENCRYPTION_KEY",
	// Deleted, never set: with a service name present, `encryptSecret` writes to
	// the real login Keychain. Tests stay on the AES-GCM path.
	"CONTEXT_LAYER_KEYCHAIN_SERVICE",
] as const

let saved: Record<string, string | undefined> = {}

let scratch = ""

beforeEach(() => {
	saved = Object.fromEntries(MODEL_ENV.map((k) => [k, process.env[k]]))
	for (const k of MODEL_ENV) delete process.env[k]
	scratch = mkdtempSync(join(tmpdir(), "contextlayer-providers-"))
	process.env.CONTEXT_LAYER_DATA_DIR = join(scratch, "data")
	process.env.CONNECTION_ENCRYPTION_KEY = "test-encryption-key"
	resetCredentialCache()
})

afterEach(() => {
	for (const k of MODEL_ENV) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
	resetCredentialCache()
})

test("resolves to null when nothing is configured", () => {
	expect(resolveChatProvider()).toBeNull()
	expect(activeEmbedProvider()).toBeNull()
	// Nothing configured means nothing is sent anywhere.
	expect(chatProviderIsRemote()).toBe(false)
	expect(embedProviderIsRemote()).toBe(false)
})

test("an existing cloud-only install keeps resolving to its cloud provider", () => {
	// The regression this guards: giving LOCAL_* a default would silently
	// redirect every existing OpenRouter/NVIDIA install to a local model.
	process.env.OPENROUTER_API_KEY = "x"
	process.env.NVIDIA_API_KEY = "x"
	expect(resolveChatProvider()).toBe("openrouter")
	expect(activeEmbedProvider()).toBe("nvidia")
	expect(chatProviderIsRemote()).toBe(true)
	expect(embedProviderIsRemote()).toBe(true)
})

test("local wins over configured cloud providers once pointed somewhere", () => {
	process.env.OPENROUTER_API_KEY = "x"
	process.env.ANTHROPIC_API_KEY = "x"
	process.env.NVIDIA_API_KEY = "x"
	process.env.LOCAL_CHAT_BASE_URL = "http://localhost:11434/v1"
	process.env.LOCAL_EMBED_BASE_URL = "http://localhost:11434/v1"
	expect(resolveChatProvider()).toBe("local")
	expect(activeEmbedProvider()).toBe("local")
	// The point of local: no consent gate, because nothing leaves the machine.
	expect(chatProviderIsRemote()).toBe(false)
	expect(embedProviderIsRemote()).toBe(false)
})

test("cloud priority is anthropic, then openai, then openrouter", () => {
	process.env.OPENROUTER_API_KEY = "x"
	expect(resolveChatProvider()).toBe("openrouter")
	process.env.OPENAI_API_KEY = "x"
	expect(resolveChatProvider()).toBe("openai")
	process.env.ANTHROPIC_API_KEY = "x"
	expect(resolveChatProvider()).toBe("anthropic")
})

test("an anthropic oauth token alone is enough to select anthropic", () => {
	process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token"
	expect(resolveChatProvider()).toBe("anthropic")
})

test("an explicit provider overrides the resolution order", () => {
	process.env.OPENROUTER_API_KEY = "x"
	process.env.LOCAL_CHAT_BASE_URL = "http://localhost:11434/v1"
	process.env.CHAT_PROVIDER = "openrouter"
	expect(resolveChatProvider()).toBe("openrouter")

	process.env.NVIDIA_API_KEY = "x"
	process.env.EMBED_PROVIDER = "nvidia"
	expect(activeEmbedProvider()).toBe("nvidia")
})

test("an unknown explicit provider fails loudly rather than falling back", () => {
	process.env.OPENROUTER_API_KEY = "x"
	process.env.CHAT_PROVIDER = "gemini" as ChatProviderId
	expect(() => resolveChatProvider()).toThrow(/Unknown CHAT_PROVIDER/)

	process.env.EMBED_PROVIDER = "cohere"
	expect(() => activeEmbedProvider()).toThrow(/Unknown EMBED_PROVIDER/)
})

// --- credentials entered in the app ---------------------------------------

test("a key stored in the app selects its provider with no env var set", () => {
	// The gap this closes: the bundled desktop app passes no model env vars at
	// all, so before this there was no way to configure a model in the product.
	storeCredential("openai", "sk-stored")
	expect(resolveChatProvider()).toBe("openai")
	expect(chatProviderIsRemote()).toBe(true)
})

test("an environment key beats a key stored in the app", () => {
	// Mirrors the CLI's own precedence, so an existing .env or CI setup keeps
	// behaving exactly as it did after this feature lands.
	storeCredential("anthropic", "sk-stored")
	process.env.ANTHROPIC_API_KEY = "sk-env"
	expect(anthropicCredential()).toEqual({
		source: "env",
		kind: "key",
		value: "sk-env",
	})
})

test("an oauth token resolves as oauth, not as a key", () => {
	// These are mutually exclusive on the wire — x-api-key and a bearer token
	// together are rejected — so the distinction has to survive resolution.
	process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token"
	expect(anthropicCredential()).toEqual({
		source: "env",
		kind: "oauth",
		value: "oauth-token",
	})
})

test("no anthropic credential anywhere resolves to null", () => {
	expect(anthropicCredential()).toBeNull()
})
