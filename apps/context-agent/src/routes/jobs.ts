import { backgroundJobs, db } from "@repo/db"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { recentJobs } from "../lib/background-jobs"
import { requireCaller } from "../lib/caller"

export const jobsRoute = new Hono()

jobsRoute.get("/", async (c) => {
	const caller = await requireCaller(c)
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10)
	const mayViewOrganizationJobs =
		caller.role === "owner" || caller.role === "admin"
	return c.json({
		jobs: await recentJobs(
			caller.orgId,
			limit,
			mayViewOrganizationJobs ? undefined : caller.userId,
		),
	})
})

jobsRoute.get("/:id", async (c) => {
	const caller = await requireCaller(c)
	const mayViewOrganizationJobs =
		caller.role === "owner" || caller.role === "admin"
	const [job] = await db
		.select()
		.from(backgroundJobs)
		.where(
			and(
				eq(backgroundJobs.id, c.req.param("id")),
				eq(backgroundJobs.orgId, caller.orgId),
				mayViewOrganizationJobs
					? undefined
					: eq(backgroundJobs.createdBy, caller.userId),
			),
		)
		.limit(1)
	if (!job) return c.json({ error: "Job not found" }, 404)
	return c.json({ job })
})

jobsRoute.post("/:id/cancel", async (c) => {
	const caller = await requireCaller(c)
	const mayCancelOrganizationJobs =
		caller.role === "owner" || caller.role === "admin"
	const [job] = await db
		.update(backgroundJobs)
		.set({
			status: "cancelled",
			leaseUntil: null,
			workerId: null,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(backgroundJobs.id, c.req.param("id")),
				eq(backgroundJobs.orgId, caller.orgId),
				mayCancelOrganizationJobs
					? undefined
					: eq(backgroundJobs.createdBy, caller.userId),
				inArray(backgroundJobs.status, ["queued", "running"]),
			),
		)
		.returning()
	if (!job) return c.json({ error: "Cancellable job not found" }, 404)
	return c.json({ job })
})
