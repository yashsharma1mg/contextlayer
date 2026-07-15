import { db, storedObjects } from "@repo/db"
import { and, eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { decryptBytes, encryptBytes } from "./secrets"

export type StoredObjectKind =
	| "source_original"
	| "capture_dom"
	| "capture_screenshot"
	| "media_keyframe"
	| "design_bundle"
	| "generated_bundle"
	| "backup"

export function contextLayerDataDir() {
	return (
		process.env.CONTEXT_LAYER_DATA_DIR ??
		join(homedir(), "Library", "Application Support", "Context Layer")
	)
}

export function objectPath(storageKey: string) {
	return join(contextLayerDataDir(), "objects", storageKey)
}

export async function storeObject(input: {
	orgId: string
	kind: StoredObjectKind
	data: Uint8Array
	mimeType: string
	metadata?: Record<string, unknown>
}) {
	const hash = createHash("sha256").update(input.data).digest("hex")
	const [existing] = await db
		.select()
		.from(storedObjects)
		.where(
			and(
				eq(storedObjects.orgId, input.orgId),
				eq(storedObjects.kind, input.kind),
				eq(storedObjects.contentHash, hash),
			),
		)
		.limit(1)
	if (existing) return existing

	const namespace = createHash("sha256")
		.update(input.orgId)
		.digest("hex")
		.slice(0, 16)
	const storageKey = join(namespace, hash.slice(0, 2), hash.slice(2, 4), hash)
	const path = objectPath(storageKey)
	const encrypted = encryptBytes(input.data)
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	await writeFile(temporary, encrypted.data, { mode: 0o600 })
	await rename(temporary, path)

	try {
		const [created] = await db
			.insert(storedObjects)
			.values({
				orgId: input.orgId,
				kind: input.kind,
				contentHash: hash,
				storageKey,
				mimeType: input.mimeType,
				sizeBytes: input.data.byteLength,
				encryption: encrypted.encryption,
				metadata: input.metadata,
			})
			.onConflictDoNothing()
			.returning()
		if (created) return created
		const [raced] = await db
			.select()
			.from(storedObjects)
			.where(
				and(
					eq(storedObjects.orgId, input.orgId),
					eq(storedObjects.kind, input.kind),
					eq(storedObjects.contentHash, hash),
				),
			)
			.limit(1)
		if (!raced) throw new Error("Stored object metadata was not created")
		return raced
	} catch (error) {
		await rm(path, { force: true })
		throw error
	}
}

export async function readObject(id: string, orgId: string) {
	const [object] = await db
		.select()
		.from(storedObjects)
		.where(and(eq(storedObjects.id, id), eq(storedObjects.orgId, orgId)))
		.limit(1)
	if (!object) return null
	const data = await readFile(objectPath(object.storageKey))
	return {
		object,
		data: object.encryption
			? decryptBytes(data, object.encryption)
			: Buffer.from(data),
	}
}
