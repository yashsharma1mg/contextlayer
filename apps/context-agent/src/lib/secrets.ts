import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto"

const prefix = "enc:v1:"

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

export function encryptSecret(value: string) {
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
