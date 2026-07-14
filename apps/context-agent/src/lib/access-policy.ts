import { and, eq, inArray, or } from "drizzle-orm"
import { documents } from "@repo/db/schema"
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
		eq(documents.scope, "org"),
		caller.teamIds.length > 0
			? and(
					eq(documents.scope, "team"),
					inArray(documents.teamId, caller.teamIds),
				)
			: undefined,
		and(
			eq(documents.scope, "personal"),
			eq(documents.ownerUserId, caller.userId),
		),
	)
}
