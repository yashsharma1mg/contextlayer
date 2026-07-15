import { zValidator } from "@hono/zod-validator"
import { db, providerConsents } from "@repo/db"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import { requireCaller } from "../lib/caller"
import { canManageOrganization } from "../lib/organization-access"

export const privacyRoute = new Hono()

const dataDirectory = () =>
	process.env.CONTEXT_LAYER_DATA_DIR ??
	join(homedir(), "Library", "Application Support", "Context Layer")

async function requireDataOwner(c: Parameters<typeof requireCaller>[0]) {
	const caller = await requireCaller(c)
	if (!canManageOrganization(caller.role)) {
		throw new HTTPException(403, { message: "Owner access required" })
	}
	return caller
}

privacyRoute.get("/backups", async (c) => {
	await requireDataOwner(c)
	const directory = join(dataDirectory(), "backups")
	await mkdir(directory, { recursive: true })
	const backups = await Promise.all(
		(await readdir(directory))
			.filter((name) => /^[a-z0-9-]+\.dump$/.test(name))
			.map(async (name) => {
				const details = await stat(join(directory, name))
				return { name, size: details.size, createdAt: details.mtime }
			}),
	)
	return c.json({
		backups: backups.sort(
			(left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
		),
	})
})

privacyRoute.post("/backups", async (c) => {
	await requireDataOwner(c)
	const pgDump = process.env.PG_DUMP_PATH
	if (!pgDump)
		return c.json({ error: "Backups are available in the desktop app" }, 501)
	const directory = join(dataDirectory(), "backups")
	await mkdir(directory, { recursive: true })
	const name = `manual-${Date.now()}.dump`
	const destination = join(directory, name)
	const child = Bun.spawn(
		[pgDump, "--format=custom", "--create", "--file", destination],
		{ env: Bun.env, stdout: "ignore", stderr: "pipe" },
	)
	const status = await child.exited
	if (status !== 0) {
		const error = await new Response(child.stderr).text()
		return c.json({ error: error.trim() || "Database backup failed" }, 500)
	}
	await chmod(destination, 0o600)
	return c.json({ backup: { name } }, 201)
})

privacyRoute.post(
	"/backups/:name/restore",
	zValidator(
		"param",
		z.object({ name: z.string().regex(/^[a-z0-9-]+\.dump$/) }),
	),
	async (c) => {
		await requireDataOwner(c)
		const directory = join(dataDirectory(), "backups")
		const name = basename(c.req.valid("param").name)
		const source = join(directory, name)
		await stat(source)
		await writeFile(join(dataDirectory(), "restore-request"), source, {
			mode: 0o600,
		})
		return c.json({ restartRequired: true })
	},
)

privacyRoute.get("/consents", async (c) => {
	const caller = await requireCaller(c)
	const consents = await db
		.select()
		.from(providerConsents)
		.where(
			and(
				eq(providerConsents.orgId, caller.orgId),
				eq(providerConsents.userId, caller.userId),
			),
		)
	return c.json({ consents })
})

privacyRoute.put(
	"/consents/:provider",
	zValidator(
		"json",
		z.object({
			purposes: z.array(z.enum(["embeddings", "generation", "media"])).min(1),
		}),
	),
	async (c) => {
		const caller = await requireCaller(c)
		const provider = c.req.param("provider").trim().toLowerCase()
		if (!/^[a-z0-9_-]{2,40}$/.test(provider)) {
			return c.json({ error: "Invalid provider" }, 400)
		}
		const [consent] = await db
			.insert(providerConsents)
			.values({
				orgId: caller.orgId,
				userId: caller.userId,
				provider,
				purposes: c.req.valid("json").purposes,
			})
			.onConflictDoUpdate({
				target: [
					providerConsents.orgId,
					providerConsents.userId,
					providerConsents.provider,
				],
				set: {
					purposes: c.req.valid("json").purposes,
					grantedAt: new Date(),
					revokedAt: null,
				},
			})
			.returning()
		return c.json({ consent })
	},
)

privacyRoute.delete("/consents/:provider", async (c) => {
	const caller = await requireCaller(c)
	const [consent] = await db
		.update(providerConsents)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(providerConsents.orgId, caller.orgId),
				eq(providerConsents.userId, caller.userId),
				eq(providerConsents.provider, c.req.param("provider")),
			),
		)
		.returning()
	if (!consent) return c.json({ error: "Consent not found" }, 404)
	return c.json({ consent })
})
