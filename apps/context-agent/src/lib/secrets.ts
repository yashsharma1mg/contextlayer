import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto"
import { spawnSync } from "node:child_process"

const prefix = "enc:v1:"
const keychainPrefix = "keychain:v1:"

function keychainService() {
	return process.env.CONTEXT_LAYER_KEYCHAIN_SERVICE
}

function keychainAccount(hint: string) {
	return `connector-${createHash("sha256").update(hint).digest("hex")}`
}

function writeKeychainSecret(account: string, value: string) {
	const service = keychainService()
	if (!service) return false
	const result = spawnSync(
		"/usr/bin/security",
		["add-generic-password", "-U", "-s", service, "-a", account, "-w", value],
		{ stdio: "ignore" },
	)
	if (result.status !== 0)
		throw new Error("Could not store connector credentials in macOS Keychain")
	return true
}

export function assertConnectionEncryptionConfigured() {
	if (
		process.env.NODE_ENV === "production" &&
		!process.env.CONNECTION_ENCRYPTION_KEY
	) {
		throw new Error(
			"CONNECTION_ENCRYPTION_KEY is required when running in production",
		)
	}
}

function key() {
	assertConnectionEncryptionConfigured()
	const secret =
		process.env.CONNECTION_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET
	if (!secret) {
		throw new Error(
			"CONNECTION_ENCRYPTION_KEY or BETTER_AUTH_SECRET is required",
		)
	}
	return createHash("sha256").update(secret).digest()
}

export function encryptBytes(value: Uint8Array) {
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", key(), iv)
	const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
	return {
		data: encrypted,
		encryption: {
			algorithm: "aes-256-gcm" as const,
			iv: iv.toString("base64url"),
			tag: cipher.getAuthTag().toString("base64url"),
		},
	}
}

export function decryptBytes(
	value: Uint8Array,
	encryption: { algorithm: "aes-256-gcm"; iv: string; tag: string },
) {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key(),
		Buffer.from(encryption.iv, "base64url"),
	)
	decipher.setAuthTag(Buffer.from(encryption.tag, "base64url"))
	return Buffer.concat([decipher.update(value), decipher.final()])
}

export function encryptSecret(value: string, accountHint?: string) {
	if (value && accountHint) {
		const account = keychainAccount(accountHint)
		if (writeKeychainSecret(account, value))
			return `${keychainPrefix}${account}`
	}
	const iv = randomBytes(12)
	const cipher = createCipheriv("aes-256-gcm", key(), iv)
	const encrypted = Buffer.concat([
		cipher.update(value, "utf8"),
		cipher.final(),
	])
	const tag = cipher.getAuthTag()
	return `${prefix}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`
}

export function decryptSecret(value: string) {
	if (value.startsWith(keychainPrefix)) {
		const service = keychainService()
		if (!service) throw new Error("macOS Keychain access is not configured")
		const result = spawnSync(
			"/usr/bin/security",
			[
				"find-generic-password",
				"-s",
				service,
				"-a",
				value.slice(keychainPrefix.length),
				"-w",
			],
			{ encoding: "utf8" },
		)
		if (result.status !== 0)
			throw new Error("Connector credential is missing from macOS Keychain")
		return result.stdout.trimEnd()
	}
	if (!value.startsWith(prefix)) return value
	const [ivValue, tagValue, encryptedValue] = value
		.slice(prefix.length)
		.split(":")
	if (!ivValue || !tagValue || !encryptedValue)
		throw new Error("Invalid encrypted secret")
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key(),
		Buffer.from(ivValue, "base64url"),
	)
	decipher.setAuthTag(Buffer.from(tagValue, "base64url"))
	return Buffer.concat([
		decipher.update(Buffer.from(encryptedValue, "base64url")),
		decipher.final(),
	]).toString("utf8")
}

export function deleteSecret(value: string) {
	if (!value.startsWith(keychainPrefix)) return
	const service = keychainService()
	if (!service) return
	spawnSync(
		"/usr/bin/security",
		[
			"delete-generic-password",
			"-s",
			service,
			"-a",
			value.slice(keychainPrefix.length),
		],
		{ stdio: "ignore" },
	)
}

export function encryptConnectionSecret(
	orgId: string,
	provider: string,
	kind: "access" | "refresh",
	value: string,
) {
	return encryptSecret(value, `${orgId}:${provider}:${kind}`)
}
