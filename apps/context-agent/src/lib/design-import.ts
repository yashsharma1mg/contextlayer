import { db, designImportRuns, designSystems } from "@repo/db"
import { and, desc, eq, ne } from "drizzle-orm"
import JSZip from "jszip"
import { extract as createTarExtractor } from "tar-stream"
import { gunzipSync } from "node:zlib"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getValidFigmaConnection } from "./connections"
import {
	extractComponents,
	getFile,
	getLocalVariables,
	parseFileKey,
} from "./figma"
import { readObject } from "./local-storage"
import { safeFetchText } from "./safe-fetch"

type Asset = {
	name: string
	description?: string
	importPath?: string
	exportName?: string
	props?: Record<string, unknown>
	variants?: Record<string, unknown>
	slots?: string[]
	examples?: string[]
	accessibility?: string[]
	composition?: string[]
	sourceMappings?: string[]
	importSource?: Record<string, unknown>
}

export type CandidateManifest = {
	schemaVersion: 1
	name: string
	version: string
	framework: "react"
	packageName: string
	preview: { entry: string; css?: string; peerDependencies: string[] }
	foundations: Asset[]
	tokens: Asset[]
	primitives: Asset[]
	components: Asset[]
	patterns: Asset[]
	templates: Asset[]
	sourceMappings: string[]
	importSources: Record<string, unknown>[]
	validationProvenance: Record<string, unknown>
}

const assetGroups = [
	"foundations",
	"tokens",
	"primitives",
	"components",
	"patterns",
	"templates",
] as const

function unique(values: (string | undefined)[]) {
	return [...new Set(values.filter((value): value is string => !!value))]
}

export function validateCandidateManifest(manifest: CandidateManifest) {
	const issues: Record<string, unknown>[] = []
	const executable = [
		...manifest.primitives,
		...manifest.components,
		...manifest.patterns,
		...manifest.templates,
	]
	if (!executable.length) {
		issues.push({
			path: "components",
			message: "At least one UI asset is required",
		})
	}
	for (const group of assetGroups) {
		const seen = new Set<string>()
		for (const asset of manifest[group]) {
			if (seen.has(asset.name)) {
				issues.push({
					path: `${group}.${asset.name}`,
					message: "Duplicate asset name",
				})
			}
			seen.add(asset.name)
		}
	}
	for (const asset of executable) {
		if (!asset.importPath || !asset.exportName) {
			issues.push({
				path: `components.${asset.name}`,
				message:
					"React import path and export name are required before activation",
			})
		}
	}
	return issues
}

function mergeAssets(
	left: Asset[],
	right: Asset[],
	group: string,
	issues: Record<string, unknown>[],
) {
	const merged = new Map(left.map((asset) => [asset.name, asset]))
	for (const asset of right) {
		const previous = merged.get(asset.name)
		if (!previous) {
			merged.set(asset.name, asset)
			continue
		}
		for (const field of ["importPath", "exportName"] as const) {
			if (previous[field] && asset[field] && previous[field] !== asset[field]) {
				issues.push({
					path: `${group}.${asset.name}.${field}`,
					message: `Conflicting ${field}: ${previous[field]} and ${asset[field]}`,
				})
			}
		}
		merged.set(asset.name, {
			...previous,
			...asset,
			importPath: previous.importPath ?? asset.importPath,
			exportName: previous.exportName ?? asset.exportName,
			description: asset.description ?? previous.description,
			props: { ...previous.props, ...asset.props },
			variants: { ...previous.variants, ...asset.variants },
			slots: unique([...(previous.slots ?? []), ...(asset.slots ?? [])]),
			examples: unique([
				...(previous.examples ?? []),
				...(asset.examples ?? []),
			]),
			accessibility: unique([
				...(previous.accessibility ?? []),
				...(asset.accessibility ?? []),
			]),
			composition: unique([
				...(previous.composition ?? []),
				...(asset.composition ?? []),
			]),
			sourceMappings: unique([
				...(previous.sourceMappings ?? []),
				...(asset.sourceMappings ?? []),
			]),
			importSource: asset.importSource ?? previous.importSource,
		})
	}
	return [...merged.values()]
}

export function mergeCandidateManifests(
	previous: CandidateManifest,
	current: CandidateManifest,
) {
	const issues: Record<string, unknown>[] = []
	const previousHasPackage = previous.importSources.some(
		(source) => source.type === "package",
	)
	const currentHasPackage = current.importSources.some(
		(source) => source.type === "package",
	)
	const packageManifest = currentHasPackage
		? current
		: previousHasPackage
			? previous
			: current
	const manifest: CandidateManifest = {
		...packageManifest,
		name: current.name,
		version: currentHasPackage ? current.version : previous.version,
		importSources: [...previous.importSources, ...current.importSources],
		sourceMappings: unique([
			...previous.sourceMappings,
			...current.sourceMappings,
		]),
		validationProvenance: {
			...previous.validationProvenance,
			...current.validationProvenance,
			mergedAt: new Date().toISOString(),
		},
		foundations: [],
		tokens: [],
		primitives: [],
		components: [],
		patterns: [],
		templates: [],
	}
	for (const group of assetGroups) {
		manifest[group] = mergeAssets(
			previous[group],
			current[group],
			group,
			issues,
		)
	}
	return {
		manifest,
		issues: [...issues, ...validateCandidateManifest(manifest)],
	}
}

type ImportResult = {
	manifest: CandidateManifest
	issues: Record<string, unknown>[]
}
type ArchiveEntry = {
	name: string
	size: number
	data: () => Promise<Uint8Array>
	text: () => Promise<string>
}

function skeleton(input: {
	name: string
	version?: string
	packageName?: string
	entry?: string
	css?: string
	source: Record<string, unknown>
}): CandidateManifest {
	return {
		schemaVersion: 1,
		name: input.name,
		version: input.version || "0.1.0",
		framework: "react",
		packageName: input.packageName || "@local/design-system",
		preview: {
			entry: input.entry || "./src/index.ts",
			css: input.css,
			peerDependencies: [],
		},
		foundations: [],
		tokens: [],
		primitives: [],
		components: [],
		patterns: [],
		templates: [],
		sourceMappings: [],
		importSources: [input.source],
		validationProvenance: {
			importedAt: new Date().toISOString(),
			validator: "context-layer/design-manifest-v1",
		},
	}
}

export function safeArchivePath(path: string) {
	return (
		!path.startsWith("/") &&
		!path.startsWith("\\") &&
		!path.split(/[\\/]/).includes("..")
	)
}

export function validatePackageSource(path: string, text: string) {
	if (!/\.(?:[cm]?[jt]sx?|css)$/i.test(path)) return
	const rules: [RegExp, string][] = [
		[/\b(?:with|assert)\s*\{\s*type\s*:\s*["']macro["']/i, "build-time macros"],
		[/\b(?:eval\s*\(|new\s+Function\s*\()/, "dynamic code evaluation"],
		[/\b(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))/, "unbounded loops"],
		[
			/\b(?:SharedWorker|Worker|WebAssembly|importScripts)\b/,
			"nested execution runtimes",
		],
		[/@import\s+(?:url\()?\s*["']?https?:/i, "remote CSS imports"],
	]
	for (const [pattern, label] of rules) {
		if (pattern.test(text)) {
			throw new Error(`Unsafe ${label} in design package file ${path}`)
		}
	}
}

export async function archiveEntries(
	data: Uint8Array,
): Promise<ArchiveEntry[]> {
	if (data[0] === 0x1f && data[1] === 0x8b) {
		const unpacked = gunzipSync(data, { maxOutputLength: 250 * 1024 * 1024 })
		return new Promise((resolve, reject) => {
			const extractor = createTarExtractor()
			const entries: ArchiveEntry[] = []
			extractor.on("entry", (header, stream, next) => {
				const chunks: Buffer[] = []
				let size = 0
				stream.on("data", (chunk: Buffer) => {
					size += chunk.length
					if (size <= 10 * 1024 * 1024) chunks.push(chunk)
				})
				stream.on("end", () => {
					if (header.type === "file") {
						const value = Buffer.concat(chunks)
						entries.push({
							name: header.name,
							size,
							data: async () => value,
							text: async () => value.toString("utf8"),
						})
					}
					next()
				})
				stream.resume()
			})
			extractor.on("finish", () => resolve(entries))
			extractor.on("error", reject)
			extractor.end(unpacked)
		})
	}
	const zip = await JSZip.loadAsync(data, { createFolders: false })
	return Object.values(zip.files)
		.filter((entry) => !entry.dir)
		.map((entry) => ({
			name: entry.name,
			size: Number(
				(entry as unknown as { _data?: { uncompressedSize?: number } })._data
					?.uncompressedSize ?? 0,
			),
			data: () => entry.async("uint8array"),
			text: () => entry.async("text"),
		}))
}

export async function materializeDesignPackage(
	data: Uint8Array,
	destination: string,
) {
	const entries = await archiveEntries(data)
	if (entries.length > 5_000)
		throw new Error("Design archive contains too many files")
	const packageFile = entries
		.filter((entry) => /(^|\/)package\.json$/.test(entry.name))
		.sort((a, b) => a.name.length - b.name.length)[0]
	if (!packageFile) throw new Error("Archive does not contain package.json")
	const root = packageFile.name.slice(0, -"package.json".length)
	let total = 0
	for (const entry of entries) {
		if (
			!entry.name.startsWith(root) ||
			/(?:^|\/)node_modules\//.test(entry.name)
		)
			continue
		const relative = entry.name.slice(root.length)
		if (!relative || !safeArchivePath(relative))
			throw new Error(`Unsafe archive path: ${entry.name}`)
		total += entry.size
		if (entry.size > 10 * 1024 * 1024 || total > 250 * 1024 * 1024) {
			throw new Error("Design archive exceeds expanded-size limits")
		}
		const target = join(destination, relative)
		const data = await entry.data()
		if (/\.(?:[cm]?[jt]sx?|css)$/i.test(relative)) {
			validatePackageSource(relative, Buffer.from(data).toString("utf8"))
		}
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, data, { mode: 0o600 })
	}
}

function packageEntry(packageJson: Record<string, unknown>) {
	const exports = packageJson.exports
	if (typeof exports === "string") return exports
	if (exports && typeof exports === "object") {
		const root = (exports as Record<string, unknown>)["."]
		if (typeof root === "string") return root
		if (root && typeof root === "object") {
			const record = root as Record<string, unknown>
			for (const key of ["browser", "import", "default"]) {
				if (typeof record[key] === "string") return record[key] as string
			}
		}
	}
	for (const key of ["browser", "module", "main"]) {
		if (typeof packageJson[key] === "string") return packageJson[key] as string
	}
	return "./src/index.ts"
}

function exportedNames(text: string) {
	const names = new Set<string>()
	for (const match of text.matchAll(
		/export\s+(?:declare\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		if (match[1]) names.add(match[1])
	}
	for (const match of text.matchAll(/export\s*\{([^}]+)\}/g)) {
		for (const item of (match[1] ?? "").split(",")) {
			const name = item
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.trim()
			if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
		}
	}
	return names
}

function codeConnectMappings(texts: string[]) {
	const mappings = new Map<string, string[]>()
	for (const text of texts) {
		for (const match of text.matchAll(
			/(?:figma\.)?connect\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*["'](https:\/\/[^"']+)["']/g,
		)) {
			if (!match[1] || !match[2]) continue
			mappings.set(match[1], [...(mappings.get(match[1]) ?? []), match[2]])
		}
	}
	return mappings
}

async function packageImport(
	data: Uint8Array,
	fileName: string,
	name: string,
	objectId: string,
): Promise<ImportResult> {
	if (data.byteLength > 100 * 1024 * 1024)
		throw new Error("Design archives are limited to 100 MB")
	const entries = await archiveEntries(data)
	if (entries.length > 5_000)
		throw new Error("Design archive contains too many files")
	let expandedBytes = 0
	for (const entry of entries) {
		if (!safeArchivePath(entry.name))
			throw new Error(`Unsafe archive path: ${entry.name}`)
		const size = entry.size
		expandedBytes += size
		if (size > 10 * 1024 * 1024 || expandedBytes > 250 * 1024 * 1024) {
			throw new Error("Design archive exceeds expanded-size limits")
		}
	}
	const packageFile = entries
		.filter((entry) => /(^|\/)package\.json$/.test(entry.name))
		.sort((a, b) => a.name.length - b.name.length)[0]
	if (!packageFile) throw new Error("Archive does not contain package.json")
	const packageJson = JSON.parse(await packageFile.text()) as Record<
		string,
		unknown
	>
	const packageName =
		typeof packageJson.name === "string"
			? packageJson.name
			: "@local/design-system"
	const version =
		typeof packageJson.version === "string" ? packageJson.version : "0.1.0"
	const root = packageFile.name.slice(0, -"package.json".length)
	const relevant = entries.filter(
		(entry) =>
			entry.name.startsWith(root) &&
			/\.(?:[cm]?[jt]sx?|css|json)$/.test(entry.name) &&
			!/(?:^|\/)node_modules\//.test(entry.name),
	)
	const texts: { path: string; text: string }[] = []
	let inspectedBytes = 0
	for (const entry of relevant.slice(0, 2_000)) {
		const text = await entry.text()
		inspectedBytes += Buffer.byteLength(text)
		if (inspectedBytes > 25 * 1024 * 1024) break
		texts.push({ path: entry.name.slice(root.length), text })
	}
	const entry = packageEntry(packageJson)
	const css = texts.find(({ path }) =>
		/(?:^|\/)(?:index|styles?|tokens?)\.css$/i.test(path),
	)?.path
	const manifest = skeleton({
		name,
		version,
		packageName,
		entry,
		css,
		source: { type: "package", objectId, fileName, packageName, version },
	})
	manifest.preview.peerDependencies = Object.keys(
		(packageJson.peerDependencies as Record<string, unknown> | undefined) ?? {},
	)
	const mappings = codeConnectMappings(
		texts
			.filter(({ path }) => /\.figma\.[jt]sx?$/.test(path))
			.map(({ text }) => text),
	)
	const exports = new Set<string>()
	for (const file of texts.filter(({ path }) => /\.[cm]?[jt]sx?$/.test(path))) {
		for (const exported of exportedNames(file.text)) exports.add(exported)
	}
	manifest.components = [...exports]
		.filter((exported) => /^[A-Z]/.test(exported))
		.slice(0, 2_000)
		.map((exportName) => ({
			name: exportName,
			importPath: packageName,
			exportName,
			props: {},
			variants: {},
			examples: [],
			accessibility: [],
			composition: [],
			sourceMappings: mappings.get(exportName) ?? [],
			importSource: { type: "package", packageName },
		}))
	const tokenNames = new Set<string>()
	for (const file of texts.filter(({ path }) => path.endsWith(".css"))) {
		for (const match of file.text.matchAll(
			/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)/g,
		)) {
			if (!match[1] || tokenNames.has(match[1])) continue
			tokenNames.add(match[1])
			manifest.tokens.push({
				name: match[1],
				description: match[2]?.trim(),
				importPath: css,
				importSource: { type: "css", path: file.path },
			})
		}
	}
	const issues: Record<string, unknown>[] = []
	if (!manifest.components.length)
		issues.push({
			path: "components",
			message: "No React component exports were detected",
		})
	if (!css)
		issues.push({
			path: "preview.css",
			severity: "warning",
			message: "No browser CSS entry was detected",
		})
	return { manifest, issues }
}

async function storybookImport(
	urlValue: string,
	name: string,
): Promise<ImportResult> {
	const base = new URL(urlValue)
	const indexUrl = new URL(
		"index.json",
		base.toString().endsWith("/") ? base : `${base}/`,
	)
	let fetched: Awaited<ReturnType<typeof safeFetchText>>
	try {
		fetched = await safeFetchText(indexUrl.toString())
	} catch {
		fetched = await safeFetchText(new URL("stories.json", indexUrl).toString())
	}
	const index = JSON.parse(fetched.data.toString("utf8")) as {
		entries?: Record<
			string,
			{ title?: string; name?: string; type?: string; componentPath?: string }
		>
		stories?: Record<string, { title?: string; name?: string }>
	}
	const entries = Object.values(index.entries ?? index.stories ?? {})
	const componentNames = new Set(
		entries
			.map((entry) => entry.title?.split("/").pop())
			.filter((value): value is string => !!value),
	)
	const manifest = skeleton({
		name,
		packageName: `storybook:${base.hostname}`,
		entry: fetched.url,
		source: { type: "storybook", url: base.toString(), indexUrl: fetched.url },
	})
	manifest.components = [...componentNames]
		.slice(0, 2_000)
		.map((componentName) => ({
			name: componentName,
			exportName: componentName.replace(/[^A-Za-z0-9_$]/g, ""),
			props: {},
			variants: {},
			examples: entries
				.filter((entry) => entry.title?.split("/").pop() === componentName)
				.map((entry) => entry.name ?? "Default")
				.slice(0, 20),
			accessibility: [],
			sourceMappings: [],
			importSource: { type: "storybook", url: base.toString() },
		}))
	return {
		manifest,
		issues: manifest.components.length
			? []
			: [
					{
						path: "components",
						message: "Storybook index contains no component stories",
					},
				],
	}
}

async function figmaImport(
	orgId: string,
	fileUrl: string,
	name: string,
): Promise<ImportResult> {
	const fileKey = parseFileKey(fileUrl)
	if (!fileKey) throw new Error("A valid Figma file URL is required")
	const connection = await getValidFigmaConnection(orgId)
	if (!connection) throw new Error("Figma is not connected")
	const file = await getFile(fileKey, connection.accessToken)
	const components = extractComponents(file.document)
	const manifest = skeleton({
		name,
		packageName: "@figma/read-only-library",
		entry: fileUrl,
		source: {
			type: "figma",
			fileKey,
			fileUrl,
			lastModified: file.lastModified,
		},
	})
	manifest.components = components.slice(0, 2_000).map((component) => ({
		name: component.name,
		description: component.description,
		props: component.componentPropertyDefinitions ?? {},
		variants: Object.fromEntries(
			Object.entries(component.componentPropertyDefinitions ?? {})
				.filter(([, definition]) => definition.type === "VARIANT")
				.map(([property, definition]) => [
					property,
					definition.variantOptions ?? [],
				]),
		),
		examples: [],
		accessibility: [],
		sourceMappings: [
			`https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(component.id)}`,
		],
		importSource: { type: "figma", fileKey, nodeId: component.id },
	}))
	const issues: Record<string, unknown>[] = []
	try {
		const variables = await getLocalVariables(fileKey, connection.accessToken)
		manifest.tokens = Object.values(variables.meta.variables)
			.slice(0, 2_000)
			.map((variable) => ({
				name: variable.name,
				description: variable.resolvedType,
				variants: variable.valuesByMode,
				importSource: {
					type: "figma-variable",
					fileKey,
					variableId: variable.id,
				},
			}))
	} catch (error) {
		issues.push({
			path: "tokens",
			severity: "warning",
			message:
				error instanceof Error
					? error.message
					: "Figma variables could not be read",
		})
	}
	if (!manifest.components.length)
		issues.push({
			path: "components",
			message: "No Figma components were detected",
		})
	return { manifest, issues }
}

export async function processDesignImport(runId: string) {
	const [run] = await db
		.select()
		.from(designImportRuns)
		.where(eq(designImportRuns.id, runId))
		.limit(1)
	if (!run) throw new Error("Design import run not found")
	const [system] = await db
		.select()
		.from(designSystems)
		.where(eq(designSystems.id, run.designSystemId))
		.limit(1)
	if (!system) throw new Error("Design system not found")
	await db
		.update(designImportRuns)
		.set({ status: "running" })
		.where(eq(designImportRuns.id, run.id))
	try {
		let result: ImportResult
		if (run.sourceType === "package") {
			const objectId = String(run.source.objectId ?? "")
			const object = await readObject(objectId, system.orgId)
			if (!object) throw new Error("Imported package object is missing")
			result = await packageImport(
				object.data,
				String(run.source.fileName ?? "design-system.zip"),
				system.name,
				objectId,
			)
		} else if (run.sourceType === "storybook") {
			result = await storybookImport(String(run.source.url ?? ""), system.name)
		} else if (run.sourceType === "figma") {
			result = await figmaImport(
				system.orgId,
				String(run.source.fileUrl ?? ""),
				system.name,
			)
		} else {
			throw new Error(`Unsupported design import source ${run.sourceType}`)
		}
		const [previous] = await db
			.select({ candidateManifest: designImportRuns.candidateManifest })
			.from(designImportRuns)
			.where(
				and(
					eq(designImportRuns.designSystemId, run.designSystemId),
					eq(designImportRuns.status, "succeeded"),
					ne(designImportRuns.id, run.id),
				),
			)
			.orderBy(desc(designImportRuns.completedAt))
			.limit(1)
		if (previous?.candidateManifest) {
			const merged = mergeCandidateManifests(
				previous.candidateManifest as CandidateManifest,
				result.manifest,
			)
			result = {
				manifest: merged.manifest,
				issues: [...result.issues, ...merged.issues],
			}
		} else {
			result.issues.push(...validateCandidateManifest(result.manifest))
		}
		await db
			.update(designImportRuns)
			.set({
				status: "succeeded",
				candidateManifest: result.manifest,
				issues: result.issues,
				completedAt: new Date(),
			})
			.where(
				and(
					eq(designImportRuns.id, run.id),
					eq(designImportRuns.status, "running"),
				),
			)
		return { sourceType: run.sourceType, issueCount: result.issues.length }
	} catch (error) {
		await db
			.update(designImportRuns)
			.set({
				status: "failed",
				issues: [
					{ message: error instanceof Error ? error.message : String(error) },
				],
				completedAt: new Date(),
			})
			.where(eq(designImportRuns.id, run.id))
		throw error
	}
}
