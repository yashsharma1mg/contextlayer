import { db, providerConsents } from "@repo/db"
import { and, eq, isNull } from "drizzle-orm"

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
