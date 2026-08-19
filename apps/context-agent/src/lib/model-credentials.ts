/**
 * Model provider credentials entered in the app rather than the environment.
 *
 * Machine-scoped, not org-scoped: this is desktop-local configuration — which
 * account this copy of the app talks to — unlike connector tokens, which belong
 * to an organization and live in Postgres.
 *
 * The file on disk only ever holds what `encryptSecret` returns: a
 * `keychain:v1:` reference when the desktop shell has set
 * CONTEXT_LAYER_KEYCHAIN_SERVICE, an AES-GCM blob otherwise. No cleartext
 * secret is written here in either case.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { decryptSecret, deleteSecret, encryptSecret } from "./secrets"

export type CredentialProvider = "anthropic" | "openai" | "openrouter"

const PROVIDERS: CredentialProvider[] = ["anthropic", "openai", "openrouter"]

export function isCredentialProvider(
	value: string,
): value is CredentialProvider {
	return (PROVIDERS as string[]).includes(value)
}

function dataDirectory() {
	return (
		process.env.CONTEXT_LAYER_DATA_DIR ??
		join(homedir(), "Library", "Application Support", "Context Layer")
	)
}

function storePath() {
	return join(dataDirectory(), "model-credentials.json")
}

type Store = Partial<Record<CredentialProvider, string>>

function read(): Store {
	const path = storePath()
	if (!existsSync(path)) return {}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
		if (!parsed || typeof parsed !== "object") return {}
		return parsed as Store
	} catch {
		// A corrupt store must not take generation down — it reads as "nothing
		// configured", which the UI already knows how to present.
		return {}
	}
}

function write(store: Store) {
	const path = storePath()
	mkdirSync(dirname(path), { recursive: true })
	// 0600: on the encrypted-blob path the file is the only thing standing
	// between another local account and the ciphertext.
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Cleared whenever the store is written. Provider resolution runs on every
 * generation and `resolveChatProvider` is synchronous, so reading the file each
 * time would put a stat + parse in that path for no benefit.
 */
let cache: Store | null = null

function current(): Store {
	if (!cache) cache = read()
	return cache
}

export function storeCredential(provider: CredentialProvider, value: string) {
	const store = { ...current() }
	const existing = store[provider]
	if (existing) deleteSecret(existing)
	store[provider] = encryptSecret(value, `model:${provider}:api_key`)
	write(store)
	cache = store
}

/** The decrypted key, or null when none is stored or the Keychain lost it. */
export function readCredential(provider: CredentialProvider): string | null {
	const stored = current()[provider]
	if (!stored) return null
	try {
		return decryptSecret(stored) || null
	} catch {
		// The Keychain entry was removed out from under us, or the encryption
		// key changed. Treat it as absent rather than throwing into generation.
		return null
	}
}

export function hasCredential(provider: CredentialProvider): boolean {
	return Boolean(current()[provider])
}

export function clearCredential(provider: CredentialProvider) {
	const store = { ...current() }
	const existing = store[provider]
	if (!existing) return
	deleteSecret(existing)
	delete store[provider]
	write(store)
	cache = store
}

/** Test seam: drops the in-memory copy so the next read hits disk. */
export function resetCredentialCache() {
	cache = null
}
