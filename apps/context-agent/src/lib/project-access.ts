import { db, projects } from "@repo/db"
import { and, eq, inArray, or } from "drizzle-orm"
import type { Caller } from "./caller"

export function projectVisibility(caller: Caller) {
	return and(
		eq(projects.orgId, caller.orgId),
		or(
			eq(projects.visibility, "org"),
			caller.teamIds.length > 0
				? and(
						eq(projects.visibility, "team"),
						inArray(projects.teamId, caller.teamIds),
					)
				: undefined,
			and(
				eq(projects.visibility, "personal"),
				eq(projects.ownerUserId, caller.userId),
			),
		),
	)
}

export async function getVisibleProject(projectId: string, caller: Caller) {
	const [project] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.id, projectId), projectVisibility(caller)))
	return project ?? null
}
