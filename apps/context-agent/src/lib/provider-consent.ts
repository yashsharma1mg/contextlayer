import { db, providerConsents } from "@repo/db"
import { and, eq, isNull } from "drizzle-orm"
import { activeEmbedProvider, embedProviderIsRemote } from "./embeddings"
import {
	activeChatProvider,
	chatProviderIsRemote,
	resolveChatProvider,
} from "./providers"

export type ProviderPurpose = "embeddings" | "generation" | "media"

export async function hasProviderConsent(input: {
	orgId: string
	userId?: string
	provider: string
	purpose: ProviderPurpose
}) {
	if (!input.userId) return false
	const rows = await db
		.select({ purposes: providerConsents.purposes })
		.from(providerConsents)
		.where(
			and(
				eq(providerConsents.orgId, input.orgId),
				eq(providerConsents.userId, input.userId),
				eq(providerConsents.provider, input.provider),
				isNull(providerConsents.revokedAt),
			),
		)
	return rows.some(({ purposes }) => purposes.includes(input.purpose))
}

export async function requireProviderConsent(input: {
	orgId: string
	userId?: string
	provider: string
	purpose: ProviderPurpose
}) {
	if (await hasProviderConsent(input)) return
	throw new Error(
		`Remote ${input.purpose} requires consent for provider ${input.provider}`,
	)
}

/**
 * Consent gates exist to stop content leaving the machine. A provider running
 * on localhost sends nothing anywhere, so it is allowed unconditionally — that
 * is the whole point of configuring one.
 */
export async function requireGenerationConsent(input: {
	orgId: string
	userId?: string
}) {
	if (!chatProviderIsRemote()) return
	await requireProviderConsent({
		...input,
		provider: activeChatProvider(),
		purpose: "generation",
	})
}

/** Whether optional generation is available: configured, and consented if remote. */
export async function canUseGeneration(input: {
	orgId: string
	userId?: string
}) {
	const provider = resolveChatProvider()
	if (!provider) return false
	if (!chatProviderIsRemote()) return true
	return hasProviderConsent({ ...input, provider, purpose: "generation" })
}

/** Whether semantic search is available: configured, and consented if remote. */
export async function canUseEmbeddings(input: {
	orgId: string
	userId?: string
}) {
	const provider = activeEmbedProvider()
	if (!provider) return false
	if (!embedProviderIsRemote()) return true
	return hasProviderConsent({
		...input,
		provider,
		purpose: "embeddings",
	})
}
