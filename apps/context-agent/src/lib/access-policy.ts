import { and, eq, inArray, or, sql } from "drizzle-orm"
import { documents, sourceAccessGrants } from "@repo/db/schema"
import type { Caller } from "./caller"

type ScopedResource = {
	orgId: string
	scope: "org" | "team" | "personal"
	teamId: string | null
	ownerUserId: string | null
}

export function canAccessScopedResource(
	resource: ScopedResource,
	caller: Caller,
) {
	if (resource.orgId !== caller.orgId) return false
	if (resource.scope === "org") return true
	if (resource.scope === "team") {
		return !!resource.teamId && caller.teamIds.includes(resource.teamId)
	}
	return resource.ownerUserId === caller.userId
}

export function documentVisibility(caller: Caller) {
	return or(
		sql<boolean>`exists (
			select 1 from ${sourceAccessGrants}
			where ${and(
				eq(sourceAccessGrants.documentId, documents.id),
				eq(sourceAccessGrants.principalKind, "organization"),
				eq(sourceAccessGrants.principalId, caller.orgId),
			)}
		)`,
		sql<boolean>`exists (
			select 1 from ${sourceAccessGrants}
			where ${and(
				eq(sourceAccessGrants.documentId, documents.id),
				eq(sourceAccessGrants.principalKind, "user"),
				eq(sourceAccessGrants.principalId, caller.userId),
			)}
		)`,
		caller.teamIds.length > 0
			? sql<boolean>`exists (
				select 1 from ${sourceAccessGrants}
				where ${and(
					eq(sourceAccessGrants.documentId, documents.id),
					eq(sourceAccessGrants.principalKind, "team"),
					inArray(sourceAccessGrants.principalId, caller.teamIds),
				)}
			)`
			: undefined,
	)
}
