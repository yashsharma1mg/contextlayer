import { nanoid } from "nanoid"
import { createHash } from "node:crypto"
import { z } from "zod"
import { extractDocument, extractionCategory } from "./extract-text"
import { ingestDocument } from "./ingest"
import { readObject, storeObject } from "./local-storage"
import { requireProviderConsent } from "./provider-consent"
import { safeFetchText } from "./safe-fetch"

const scope = z.discriminatedUnion("scope", [
	z.object({ scope: z.literal("org") }),
	z.object({ scope: z.literal("personal") }),
	z.object({ scope: z.literal("team"), teamId: z.string().min(1) }),
])

const uploadPayload = scope.and(
	z.object({
		orgId: z.string().min(1),
		userId: z.string().min(1),
		objectId: z.string().min(1),
		fileName: z.string().min(1).max(500),
		mimeType: z.string().max(200),
		title: z.string().max(500),
	}),
)

const urlPayload = scope.and(
	z.object({
		orgId: z.string().min(1),
		userId: z.string().min(1),
		url: z.string().url(),
		title: z.string().max(500).optional(),
	}),
)

async function requireMediaConsent(
	orgId: string,
	userId: string,
	category: ReturnType<typeof extractionCategory>,
) {
	if (category === "image" || category === "video") {
		await requireProviderConsent({
			orgId,
			userId,
			provider: "openrouter",
			purpose: "media",
		})
	}
	if (category === "audio" || category === "video") {
		await requireProviderConsent({
			orgId,
			userId,
			provider: "openai",
			purpose: "media",
		})
	}
}

async function persistDerived(
	orgId: string,
	derived: Awaited<ReturnType<typeof extractDocument>>["derived"],
) {
	return Promise.all(
		(derived ?? []).map((item) =>
			storeObject({
				orgId,
				kind: item.kind,
				data: item.data,
				mimeType: item.mimeType,
				metadata: item.metadata,
			}),
		),
	)
}

export async function ingestStoredObject(
	payload: Record<string, unknown>,
	progress: (value: number) => Promise<void>,
	signal?: AbortSignal,
) {
	const input = uploadPayload.parse(payload)
	const stored = await readObject(input.objectId, input.orgId)
	if (!stored) throw new Error("Uploaded source object is missing")
	const file = new File([stored.data], input.fileName, { type: input.mimeType })
	await requireMediaConsent(input.orgId, input.userId, extractionCategory(file))
	await progress(15)
	const extracted = await extractDocument(file, signal)
	const derived = await persistDerived(input.orgId, extracted.derived)
	await progress(65)
	const result = await ingestDocument({
		orgId: input.orgId,
		createdBy: input.userId,
		consentUserId: input.userId,
		teamId: input.scope === "team" ? input.teamId : undefined,
		ownerUserId: input.scope === "personal" ? input.userId : undefined,
		scope: input.scope,
		source: "manual",
		sourceId: `upload:${nanoid()}`,
		title: input.title,
		rawContent: extracted.text,
		sections: extracted.sections,
		mimeType: input.mimeType,
		storageKey: stored.object.id,
		provenance: {
			fileName: input.fileName,
			size: stored.object.sizeBytes,
			derivedObjectIds: derived.map((object) => object.id),
			...extracted.provenance,
		},
	})
	return { documentId: result.document.id, chunkCount: result.chunkCount }
}

export async function ingestUrl(
	payload: Record<string, unknown>,
	progress: (value: number) => Promise<void>,
	signal?: AbortSignal,
) {
	const input = urlPayload.parse(payload)
	const fetched = await safeFetchText(input.url, undefined, signal)
	await progress(15)
	const original = await storeObject({
		orgId: input.orgId,
		kind: "source_original",
		data: fetched.data,
		mimeType: fetched.contentType,
		metadata: { url: fetched.url },
	})
	const name = new URL(fetched.url).pathname.split("/").pop() || "page.html"
	const file = new File([fetched.data], name, { type: fetched.contentType })
	await requireMediaConsent(input.orgId, input.userId, extractionCategory(file))
	const extracted = await extractDocument(file, signal)
	const derived = await persistDerived(input.orgId, extracted.derived)
	await progress(65)
	const result = await ingestDocument({
		orgId: input.orgId,
		createdBy: input.userId,
		consentUserId: input.userId,
		teamId: input.scope === "team" ? input.teamId : undefined,
		ownerUserId: input.scope === "personal" ? input.userId : undefined,
		scope: input.scope,
		source: "url",
		sourceId: createHash("sha256").update(fetched.url).digest("hex"),
		title: input.title ?? new URL(fetched.url).hostname,
		url: fetched.url,
		rawContent: extracted.text,
		sections: extracted.sections,
		mimeType: fetched.contentType,
		storageKey: original.id,
		provenance: {
			finalUrl: fetched.url,
			derivedObjectIds: derived.map((object) => object.id),
			...extracted.provenance,
		},
	})
	return { documentId: result.document.id, chunkCount: result.chunkCount }
}
