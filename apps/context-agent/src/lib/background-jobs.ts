import { backgroundJobs, db } from "@repo/db"
import { and, desc, eq, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

export type JobHandler = (
	payload: Record<string, unknown>,
	context: {
		jobId: string
		progress: (value: number) => Promise<void>
		signal: AbortSignal
	},
) => Promise<Record<string, unknown> | undefined>

const handlers = new Map<string, JobHandler>()

export class JobExecutionError extends Error {
	constructor(
		message: string,
		readonly options: { retryable: boolean; retryAfterSeconds?: number },
	) {
		super(message)
	}
}

export function registerJobHandler(type: string, handler: JobHandler) {
	handlers.set(type, handler)
}

export async function enqueueJob(input: {
	orgId: string
	projectId?: string
	createdBy: string
	type: string
	payload: Record<string, unknown>
	idempotencyKey?: string
	maxAttempts?: number
}) {
	if (input.idempotencyKey) {
		const [existing] = await db
			.select()
			.from(backgroundJobs)
			.where(
				and(
					eq(backgroundJobs.orgId, input.orgId),
					eq(backgroundJobs.type, input.type),
					eq(backgroundJobs.idempotencyKey, input.idempotencyKey),
				),
			)
			.limit(1)
		if (existing) return existing
	}
	const [job] = await db
		.insert(backgroundJobs)
		.values({
			...input,
			projectId: input.projectId ?? null,
			idempotencyKey: input.idempotencyKey ?? null,
			maxAttempts: input.maxAttempts ?? 3,
		})
		.returning()
	if (!job) throw new Error("Job creation returned no row")
	return job
}

async function claimJob(workerId: string) {
	const rows = await db.execute(sql`
		update background_jobs
		set status = 'running',
			worker_id = ${workerId},
			lease_until = now() + interval '60 seconds',
			attempts = attempts + 1,
			updated_at = now(),
			error = null
		where id = (
			select id from background_jobs
			where (
				status = 'queued'
				or (status = 'running' and lease_until < now())
			)
			and run_after <= now()
			order by created_at
			for update skip locked
			limit 1
		)
		returning *
	`)
	return rows[0] as
		| (typeof backgroundJobs.$inferSelect & {
				payload: Record<string, unknown>
		  })
		| undefined
}

async function finishJob(
	job: typeof backgroundJobs.$inferSelect,
	result: Record<string, unknown> | undefined,
) {
	await db
		.update(backgroundJobs)
		.set({
			status: "succeeded",
			progress: 100,
			result: result ?? {},
			leaseUntil: null,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(eq(backgroundJobs.id, job.id), eq(backgroundJobs.status, "running")),
		)
}

async function failJob(
	job: typeof backgroundJobs.$inferSelect,
	error: unknown,
) {
	const executionError = error instanceof JobExecutionError ? error : null
	const terminal =
		executionError?.options.retryable === false ||
		job.attempts >= job.maxAttempts
	const delaySeconds = Math.min(
		3_600,
		executionError?.options.retryAfterSeconds ??
			2 ** Math.max(0, job.attempts - 1) * 5,
	)
	await db
		.update(backgroundJobs)
		.set({
			status: terminal ? "failed" : "queued",
			error: error instanceof Error ? error.message : String(error),
			leaseUntil: null,
			workerId: null,
			runAfter: terminal
				? job.runAfter
				: new Date(Date.now() + delaySeconds * 1_000),
			completedAt: terminal ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(
			and(eq(backgroundJobs.id, job.id), eq(backgroundJobs.status, "running")),
		)
}

export async function processNextJob(workerId: string) {
	const job = await claimJob(workerId)
	if (!job) return false
	const handler = handlers.get(job.type)
	if (!handler) {
		await failJob(job, new Error(`No handler registered for ${job.type}`))
		return true
	}
	try {
		const controller = new AbortController()
		const cancellationMonitor = setInterval(async () => {
			try {
				const [current] = await db
					.select({ status: backgroundJobs.status })
					.from(backgroundJobs)
					.where(eq(backgroundJobs.id, job.id))
					.limit(1)
				if (current?.status !== "running") controller.abort()
			} catch (error) {
				console.error("Job cancellation check failed:", error)
			}
		}, 1_000)
		cancellationMonitor.unref?.()
		try {
			const result = await handler(job.payload, {
				jobId: job.id,
				signal: controller.signal,
				progress: async (value) => {
					if (controller.signal.aborted) throw new Error("Job cancelled")
					const [updated] = await db
						.update(backgroundJobs)
						.set({
							progress: Math.max(0, Math.min(99, Math.round(value))),
							leaseUntil: new Date(Date.now() + 60_000),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(backgroundJobs.id, job.id),
								eq(backgroundJobs.status, "running"),
							),
						)
						.returning({ id: backgroundJobs.id })
					if (!updated) {
						controller.abort()
						throw new Error("Job cancelled")
					}
				},
			})
			await finishJob(job, result)
		} finally {
			clearInterval(cancellationMonitor)
		}
	} catch (error) {
		await failJob(job, error)
	}
	return true
}

export function startJobWorker() {
	const workerId = `local-${process.pid}-${nanoid(8)}`
	let stopped = false
	let running = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const tick = async () => {
		if (stopped || running) return
		running = true
		let processed = false
		try {
			while (!stopped && (await processNextJob(workerId))) {
				processed = true
			}
		} catch (error) {
			console.error("Background worker tick failed:", error)
		} finally {
			running = false
			if (!stopped) {
				timer = setTimeout(() => void tick(), processed ? 250 : 5_000)
				timer.unref?.()
			}
		}
	}
	void tick()
	return () => {
		stopped = true
		if (timer) clearTimeout(timer)
	}
}

export async function recentJobs(
	orgId: string,
	limit = 50,
	createdBy?: string,
) {
	return db
		.select()
		.from(backgroundJobs)
		.where(
			and(
				eq(backgroundJobs.orgId, orgId),
				createdBy ? eq(backgroundJobs.createdBy, createdBy) : undefined,
			),
		)
		.orderBy(desc(backgroundJobs.createdAt))
		.limit(Math.max(1, Math.min(100, limit)))
}
