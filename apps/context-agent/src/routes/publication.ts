import { zValidator } from "@hono/zod-validator"
import { db, generatedFileSets, ideas, publicationAudits } from "@repo/db"
import { and, desc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { enqueueJob } from "../lib/background-jobs"
import { requireCaller } from "../lib/caller"
import {
	publicationBranch,
	validateGitHubPublication,
} from "../lib/publish-github"
import { getProjectAccess } from "../lib/project-access"
import { compilePrototype } from "../lib/prototype-compile"

export const publicationRoute = new Hono()

type PublicationApproval = {
	artifactId: string
	fileSetId: string
	repository: string
	branch: string
	userId: string
	expiresAt: number
}

function approvalSecret() {
	const secret = process.env.BETTER_AUTH_SECRET
	if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
	return secret
}

function encodeApproval(input: PublicationApproval) {
	const payload = Buffer.from(JSON.stringify(input)).toString("base64url")
	const signature = createHmac("sha256", approvalSecret())
		.update(payload)
		.digest("base64url")
	return `${payload}.${signature}`
}

function decodeApproval(token: string) {
	const [payload, signature] = token.split(".")
	if (!payload || !signature) throw new Error("Invalid publication approval")
	const expected = createHmac("sha256", approvalSecret())
		.update(payload)
		.digest("base64url")
	if (
		signature.length !== expected.length ||
		!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new Error("Invalid publication approval")
	}
	const approval = JSON.parse(
		Buffer.from(payload, "base64url").toString(),
	) as PublicationApproval
	if (approval.expiresAt < Date.now())
		throw new Error("Publication approval expired")
	return approval
}

async function ownedArtifact(
	artifactId: string,
	orgId: string,
	userId: string,
) {
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, artifactId))
		.limit(1)
	if (!artifact) return null
	const access = await getProjectAccess(artifact.projectId, {
		orgId,
		userId,
		role: "member",
		teamIds: [],
	})
	if (!access || access.role !== "owner") return null
	return { artifact, access }
}

publicationRoute.get("/artifacts/:id/generated-files", async (c) => {
	const caller = await requireCaller(c)
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, c.req.param("id")))
		.limit(1)
	if (!artifact || !(await getProjectAccess(artifact.projectId, caller))) {
		return c.json({ error: "Artifact not found" }, 404)
	}
	const [fileSet] = await db
		.select()
		.from(generatedFileSets)
		.where(eq(generatedFileSets.artifactId, artifact.id))
		.orderBy(desc(generatedFileSets.createdAt))
		.limit(1)
	return c.json({ fileSet: fileSet ?? null })
})

publicationRoute.get("/artifacts/:id/preview", async (c) => {
	const caller = await requireCaller(c)
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, c.req.param("id")))
		.limit(1)
	if (!artifact || !(await getProjectAccess(artifact.projectId, caller))) {
		return c.html("<!doctype html><p>Prototype not found.</p>", 404)
	}
	try {
		const html = await compilePrototype(artifact.id, caller.orgId)
		return c.html(html, 200, {
			"Cache-Control": "private, max-age=300",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
			"Referrer-Policy": "no-referrer",
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Compilation failed"
		return c.html(
			`<!doctype html><meta charset="utf-8"><style>body{font:13px system-ui;padding:20px;color:#9f2424;white-space:pre-wrap}</style>${message.replace(/[&<>"']/g, (value) => `&#${value.charCodeAt(0)};`)}`,
			422,
		)
	}
})

publicationRoute.post("/artifacts/:id/publication-preview", async (c) => {
	const caller = await requireCaller(c)
	const owned = await ownedArtifact(
		c.req.param("id"),
		caller.orgId,
		caller.userId,
	)
	if (!owned) return c.json({ error: "Project owner access required" }, 403)
	const context = await validateGitHubPublication(owned.artifact.id)
	const branch = publicationBranch(
		context.project.name,
		context.artifact.title,
		randomUUID(),
	)
	const approvalToken = encodeApproval({
		artifactId: context.artifact.id,
		fileSetId: context.fileSet.id,
		repository: context.settings.repository,
		branch,
		userId: caller.userId,
		expiresAt: Date.now() + 15 * 60_000,
	})
	return c.json({
		repository: context.settings.repository,
		baseBranch: context.settings.baseBranch,
		branch,
		approvalToken,
		files: context.fileSet.files.map((file) => file.path),
		validation: context.fileSet.validation,
		citations: context.artifact.sourceRefs ?? [],
		repositoryReady: context.repositoryReady,
		errors: context.errors,
	})
})

publicationRoute.post(
	"/artifacts/:id/publish",
	zValidator(
		"json",
		z.object({ approved: z.literal(true), approvalToken: z.string().min(40) }),
	),
	async (c) => {
		const caller = await requireCaller(c)
		const owned = await ownedArtifact(
			c.req.param("id"),
			caller.orgId,
			caller.userId,
		)
		if (!owned) return c.json({ error: "Project owner access required" }, 403)
		let approval: PublicationApproval
		try {
			approval = decodeApproval(c.req.valid("json").approvalToken)
		} catch (error) {
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Invalid publication approval",
				},
				409,
			)
		}
		const context = await validateGitHubPublication(owned.artifact.id)
		if (context.errors.length || !context.repositoryReady) {
			return c.json(
				{ error: context.errors.join("; ") || "Repository is not ready" },
				409,
			)
		}
		if (
			approval.artifactId !== context.artifact.id ||
			approval.fileSetId !== context.fileSet.id ||
			approval.repository !== context.settings.repository ||
			approval.userId !== caller.userId
		) {
			return c.json({ error: "Publication changed after review" }, 409)
		}
		const branch = approval.branch
		const [audit] = await db
			.insert(publicationAudits)
			.values({
				projectId: context.project.id,
				artifactId: context.artifact.id,
				approvedBy: caller.userId,
				repository: context.settings.repository,
				branch,
				status: "queued",
				validation: context.fileSet.validation,
			})
			.returning()
		if (!audit) throw new Error("Publication audit creation failed")
		const job = await enqueueJob({
			orgId: caller.orgId,
			projectId: context.project.id,
			createdBy: caller.userId,
			type: "github.publish",
			payload: { auditId: audit.id },
			idempotencyKey: audit.id,
			maxAttempts: 1,
		})
		return c.json({ audit, job }, 202)
	},
)

publicationRoute.get("/artifacts/:id/publications", async (c) => {
	const caller = await requireCaller(c)
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, c.req.param("id")))
		.limit(1)
	if (!artifact || !(await getProjectAccess(artifact.projectId, caller))) {
		return c.json({ error: "Artifact not found" }, 404)
	}
	const publications = await db
		.select()
		.from(publicationAudits)
		.where(
			and(
				eq(publicationAudits.artifactId, artifact.id),
				eq(publicationAudits.projectId, artifact.projectId),
			),
		)
		.orderBy(desc(publicationAudits.createdAt))
		.limit(20)
	return c.json({ publications })
})
