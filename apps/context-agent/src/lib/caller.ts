import { db, member, team, teamMember } from "@repo/db"
import { and, eq } from "drizzle-orm"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { auth } from "../auth"

export interface Caller {
	orgId: string
	userId: string
	teamIds: string[]
	role: string
}

export async function callerForIdentity(
	orgId: string,
	userId: string,
): Promise<Caller | null> {
	const [membership] = await db
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
		.limit(1)
	if (!membership) return null
	const teams = await db
		.select({ id: teamMember.teamId })
		.from(teamMember)
		.innerJoin(team, eq(team.id, teamMember.teamId))
		.where(and(eq(teamMember.userId, userId), eq(team.organizationId, orgId)))
	return {
		orgId,
		userId,
		teamIds: teams.map(({ id }) => id),
		role: membership.role,
	}
}

export async function requireCaller(c: Context): Promise<Caller> {
	const session = await auth.api.getSession({ headers: c.req.raw.headers })
	if (!session)
		throw new HTTPException(401, { message: "Authentication required" })

	const orgId = session.session.activeOrganizationId
	if (!orgId) {
		throw new HTTPException(400, { message: "Select an organization first" })
	}

	const caller = await callerForIdentity(orgId, session.user.id)
	if (!caller) {
		throw new HTTPException(403, { message: "Organization access denied" })
	}
	return caller
}
