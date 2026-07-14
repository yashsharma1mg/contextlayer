import {
	db,
	designSystemVersions,
	generatedFileSets,
	ideas,
	projects,
} from "@repo/db"
import { desc, eq } from "drizzle-orm"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { materializeDesignPackage } from "./design-import"
import { readObject } from "./local-storage"
import { validateGeneratedFiles } from "./prototype-validation"

const cache = new Map<string, string>()
let compileTail = Promise.resolve()

async function exists(path: string) {
	return stat(path).then(
		() => true,
		() => false,
	)
}

function runtimeRoot() {
	return (
		process.env.STUDIO_RUNTIME_DIR ??
		resolve(process.cwd(), "apps/studio/.next/standalone")
	)
}

async function linkPackage(root: string, packageName: string, target: string) {
	if (!/^(@[-\w.]+\/)?[-\w.]+$/.test(packageName)) return false
	const source = join(root, "node_modules", packageName)
	if (!(await exists(source))) return false
	await mkdir(dirname(target), { recursive: true })
	await symlink(source, target, "dir")
	return true
}

function htmlDocument(script: string, css: string) {
	const safeScript = script.replace(/<\/script/gi, "<\\/script")
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body,#root{min-height:100%;margin:0}${css}</style></head><body><div id="root"></div><script>${safeScript}</script></body></html>`
}

async function compileInWorker(entry: string, outdir: string) {
	const configured = process.env.PROTOTYPE_COMPILER_PATH
	const command = configured
		? [configured]
		: [
				process.execPath,
				resolve(
					import.meta.dir,
					"../../../desktop/scripts/prototype-compiler.ts",
				),
			]
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 20_000)
	try {
		const child = Bun.spawn(command, {
			signal: controller.signal,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		})
		child.stdin.write(JSON.stringify({ entry, outdir }))
		child.stdin.end()
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		if (controller.signal.aborted)
			throw new Error("Prototype compilation timed out")
		if (exitCode !== 0)
			throw new Error(stderr || "Prototype compilation failed")
		return JSON.parse(stdout) as {
			success: boolean
			logs: string[]
			outputs: { path: string; content: string }[]
		}
	} finally {
		clearTimeout(timeout)
	}
}

async function buildPrototype(artifactId: string, orgId: string) {
	const [artifact] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, artifactId))
		.limit(1)
	if (!artifact || artifact.kind !== "react_prototype") {
		throw new Error("React prototype not found")
	}
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.id, artifact.projectId))
		.limit(1)
	if (
		!project ||
		project.orgId !== orgId ||
		!project.pinnedDesignSystemVersionId
	) {
		throw new Error("Pinned design system not found")
	}
	const [[fileSet], [version]] = await Promise.all([
		db
			.select()
			.from(generatedFileSets)
			.where(eq(generatedFileSets.artifactId, artifact.id))
			.orderBy(desc(generatedFileSets.createdAt))
			.limit(1),
		db
			.select()
			.from(designSystemVersions)
			.where(eq(designSystemVersions.id, project.pinnedDesignSystemVersionId))
			.limit(1),
	])
	if (!fileSet || !version)
		throw new Error("Generated files or design system are missing")
	const cached = cache.get(fileSet.id)
	if (cached) return cached
	const approvedImports = Array.isArray(fileSet.validation.approvedImports)
		? fileSet.validation.approvedImports.filter(
				(value): value is string => typeof value === "string",
			)
		: []
	const validationErrors = validateGeneratedFiles(
		fileSet.files,
		approvedImports,
	)
	if (validationErrors.length) throw new Error(validationErrors.join("; "))

	const manifest = version.manifest as {
		packageName?: string
		preview?: { css?: string; peerDependencies?: string[] }
		importSources?: Record<string, unknown>[]
	}
	const packageName = manifest.packageName
	if (!packageName || !/^(@[-\w.]+\/)?[-\w.]+$/.test(packageName)) {
		throw new Error("Design-system package name is invalid")
	}
	const source = manifest.importSources?.find(
		(candidate) =>
			candidate.type === "package" && typeof candidate.objectId === "string",
	)
	if (!source || typeof source.objectId !== "string") {
		throw new Error("This design-system version has no local browser package")
	}
	const object = await readObject(source.objectId, orgId)
	if (!object) throw new Error("Design-system package is missing")

	const directory = await mkdtemp(join(tmpdir(), "context-layer-preview-"))
	try {
		for (const file of fileSet.files) {
			const target = resolve(directory, file.path)
			if (!target.startsWith(`${resolve(directory)}/`))
				throw new Error("Unsafe generated path")
			await mkdir(dirname(target), { recursive: true })
			await writeFile(target, file.content, { mode: 0o600 })
		}
		const modules = join(directory, "node_modules")
		await mkdir(modules, { recursive: true })
		await materializeDesignPackage(object.data, join(modules, packageName))
		const runtime = runtimeRoot()
		for (const dependency of [
			"react",
			"react-dom",
			...(manifest.preview?.peerDependencies ?? []),
		]) {
			if (dependency === packageName) continue
			await linkPackage(runtime, dependency, join(modules, dependency))
		}
		const first =
			fileSet.files.find((file) => file.path.endsWith("App.tsx")) ??
			fileSet.files[0]
		if (!first) throw new Error("Prototype has no entry file")
		const cssImport = manifest.preview?.css
			? `import ${JSON.stringify(`${packageName}/${manifest.preview.css.replace(/^\.\//, "")}`)};`
			: ""
		const entry = join(directory, "context-layer-entry.tsx")
		await writeFile(
			entry,
			`import React from "react"; import { createRoot } from "react-dom/client"; import App from ${JSON.stringify(`./${first.path}`)}; ${cssImport} createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);`,
		)
		const result = await compileInWorker(entry, join(directory, "dist"))
		if (!result.success) {
			throw new Error(result.logs.join("; "))
		}
		let script = ""
		let css = ""
		for (const output of result.outputs) {
			if (output.path.endsWith(".js")) script += output.content
			if (output.path.endsWith(".css")) css += output.content
		}
		if (!script || Buffer.byteLength(script) > 5 * 1024 * 1024) {
			throw new Error("Compiled prototype is empty or too large")
		}
		const html = htmlDocument(script, css)
		await db
			.update(generatedFileSets)
			.set({
				validation: {
					...fileSet.validation,
					compiled: true,
					compiledAt: new Date().toISOString(),
				},
			})
			.where(eq(generatedFileSets.id, fileSet.id))
		cache.set(fileSet.id, html)
		while (cache.size > 3) cache.delete(cache.keys().next().value as string)
		return html
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

export function compilePrototype(artifactId: string, orgId: string) {
	const run = compileTail.then(() => buildPrototype(artifactId, orgId))
	compileTail = run.then(
		() => undefined,
		() => undefined,
	)
	return run
}
