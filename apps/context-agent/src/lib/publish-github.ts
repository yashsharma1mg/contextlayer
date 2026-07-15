import {
	db,
	generatedFileSets,
	ideas,
	projectGitHubSettings,
	projects,
	publicationAudits,
} from "@repo/db"
import { desc, eq } from "drizzle-orm"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, posix, resolve } from "node:path"
import { isAllowedRepositoryFile } from "./github-publication"
import { validateGeneratedFiles } from "./prototype-validation"
import { compilePrototype } from "./prototype-compile"

async function command(args: string[], cwd?: string) {
	const process = Bun.spawn(args, {
		cwd,
		env: processEnv(),
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	])
	if (exitCode !== 0) {
		throw new Error(`${args[0]} failed: ${(stderr || stdout).trim()}`)
	}
	return stdout.trim()
}

function processEnv() {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	)
}

function slug(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "artifact"
	)
}

export async function publicationContext(artifactId: string) {
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, artifactId))
		.limit(1)
	if (!artifact || artifact.kind !== "react_prototype")
		throw new Error("React prototype not found")
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.id, artifact.projectId))
		.limit(1)
	const [settings] = await db
		.select()
		.from(projectGitHubSettings)
		.where(eq(projectGitHubSettings.projectId, artifact.projectId))
		.limit(1)
	const [fileSet] = await db
		.select()
		.from(generatedFileSets)
		.where(eq(generatedFileSets.artifactId, artifact.id))
		.orderBy(desc(generatedFileSets.createdAt))
		.limit(1)
	if (!project || !settings || !fileSet)
		throw new Error("Publication settings or generated files are missing")
	const approvedImports = Array.isArray(fileSet.validation.approvedImports)
		? fileSet.validation.approvedImports.filter(
				(value): value is string => typeof value === "string",
			)
		: []
	const errors = validateGeneratedFiles(fileSet.files, approvedImports)
	for (const file of fileSet.files) {
		if (
			!isAllowedRepositoryFile(
				file.path,
				settings.appRoot,
				settings.allowedPaths,
			)
		) {
			errors.push(
				`Generated path is outside the publication allowlist: ${file.path}`,
			)
		}
	}
	return { artifact, project, settings, fileSet, errors }
}

export async function validateGitHubPublication(artifactId: string) {
	let context = await publicationContext(artifactId)
	if (context.errors.length) return { ...context, repositoryReady: false }
	try {
		await compilePrototype(artifactId, context.project.orgId)
	} catch (error) {
		return {
			...context,
			errors: [
				...context.errors,
				error instanceof Error ? error.message : "Prototype compilation failed",
			],
			repositoryReady: false,
		}
	}
	context = await publicationContext(artifactId)
	if (context.fileSet.validation.compiled !== true) {
		return {
			...context,
			errors: [...context.errors, "Prototype compilation was not verified"],
			repositoryReady: false,
		}
	}
	await command(["gh", "auth", "status"])
	const repository = JSON.parse(
		await command([
			"gh",
			"repo",
			"view",
			context.settings.repository,
			"--json",
			"nameWithOwner,defaultBranchRef",
		]),
	) as { nameWithOwner: string; defaultBranchRef?: { name?: string } }
	await command([
		"gh",
		"api",
		`repos/${context.settings.repository}/branches/${encodeURIComponent(context.settings.baseBranch)}`,
		"--silent",
	])
	return { ...context, repositoryReady: true, repository }
}

export async function publishArtifactToGitHub(auditId: string) {
	const [audit] = await db
		.select()
		.from(publicationAudits)
		.where(eq(publicationAudits.id, auditId))
		.limit(1)
	if (!audit) throw new Error("Publication audit not found")
	await db
		.update(publicationAudits)
		.set({ status: "running", error: null })
		.where(eq(publicationAudits.id, audit.id))
	let directory: string | null = null
	try {
		const context = await validateGitHubPublication(audit.artifactId)
		if (context.errors.length || !context.repositoryReady) {
			throw new Error(
				context.errors.join("; ") || "Repository validation failed",
			)
		}
		if (context.settings.repository !== audit.repository) {
			throw new Error("Publication repository changed after approval")
		}
		directory = await mkdtemp(join(tmpdir(), "context-layer-publish-"))
		await command([
			"gh",
			"repo",
			"clone",
			context.settings.repository,
			directory,
			"--",
			"--depth=1",
			`--branch=${context.settings.baseBranch}`,
		])
		await command(["git", "checkout", "-b", audit.branch], directory)
		const written: string[] = []
		for (const file of context.fileSet.files) {
			const relative = posix.normalize(
				posix.join(context.settings.appRoot, file.path),
			)
			const destination = resolve(directory, relative)
			if (!destination.startsWith(`${resolve(directory)}/`))
				throw new Error(`Unsafe generated path: ${file.path}`)
			await mkdir(dirname(destination), { recursive: true })
			await writeFile(destination, file.content, { mode: 0o600 })
			written.push(relative)
		}
		await command(["git", "add", "--", ...written], directory)
		await command(
			[
				"git",
				"-c",
				"user.name=Context Layer",
				"-c",
				"user.email=contextlayer@local",
				"commit",
				"-m",
				`Add ${context.artifact.title}`,
			],
			directory,
		)
		await command(
			["git", "push", "--set-upstream", "origin", audit.branch],
			directory,
		)
		const citations = (context.artifact.sourceRefs ?? [])
			.map(
				(source) => `- ${source.title}${source.url ? ` (${source.url})` : ""}`,
			)
			.join("\n")
		const body = [
			"Generated and explicitly approved in Context Layer.",
			`Artifact: ${context.artifact.id}`,
			`Design-system version: ${String(context.fileSet.validation.manifestVersionId ?? "unknown")}`,
			"Validation: approved imports, paths, and TypeScript compilation passed.",
			citations
				? `Evidence:\n${citations}`
				: "Evidence: no external sources selected.",
		].join("\n\n")
		const pullRequestUrl = await command([
			"gh",
			"pr",
			"create",
			"--repo",
			context.settings.repository,
			"--base",
			context.settings.baseBranch,
			"--head",
			audit.branch,
			"--title",
			`Context Layer: ${context.artifact.title}`,
			"--body",
			body,
		])
		await db
			.update(publicationAudits)
			.set({
				status: "succeeded",
				pullRequestUrl,
				completedAt: new Date(),
			})
			.where(eq(publicationAudits.id, audit.id))
		return { pullRequestUrl, branch: audit.branch }
	} catch (error) {
		await db
			.update(publicationAudits)
			.set({
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				completedAt: new Date(),
			})
			.where(eq(publicationAudits.id, audit.id))
		throw error
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true })
	}
}

export function publicationBranch(
	projectName: string,
	artifactTitle: string,
	suffix: string,
) {
	return `contextlayer/${slug(projectName)}-${slug(artifactTitle)}-${suffix.slice(0, 6)}`
}
