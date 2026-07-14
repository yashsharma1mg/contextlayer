import { db, projectMembers, projects } from "@repo/db"
import { and, eq, inArray, or, sql } from "drizzle-orm"
import type { Caller } from "./caller"

export type ProjectRole = "owner" | "editor" | "viewer"

const roleRank: Record<ProjectRole, number> = {
	viewer: 1,
	editor: 2,
	owner: 3,
}

export function projectRoleAllows(role: ProjectRole, required: ProjectRole) {
	return roleRank[role] >= roleRank[required]
}

export function projectVisibility(caller: Caller) {
	return and(
		eq(projects.orgId, caller.orgId),
		or(
			eq(projects.ownerUserId, caller.userId),
			sql<boolean>`exists (
				select 1 from ${projectMembers}
				where ${projectMembers.projectId} = ${projects.id}
				and ${projectMembers.userId} = ${caller.userId}
			)`,
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

export async function getProjectAccess(projectId: string, caller: Caller) {
	const [project] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.orgId, caller.orgId)))
		.limit(1)
	if (!project) return null
	if (project.ownerUserId === caller.userId) {
		return { project, role: "owner" as const }
	}
	const [membership] = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, projectId),
				eq(projectMembers.userId, caller.userId),
			),
		)
		.limit(1)
	if (membership) return { project, role: membership.role }
	const visibleByScope =
		project.visibility === "org" ||
		(project.visibility === "team" &&
			!!project.teamId &&
			caller.teamIds.includes(project.teamId))
	return visibleByScope ? { project, role: "viewer" as const } : null
}

export async function getVisibleProject(projectId: string, caller: Caller) {
	return (await getProjectAccess(projectId, caller))?.project ?? null
}
