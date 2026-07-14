import { connectorCursors, connections, db, documents } from "@repo/db"
import { and, eq, notInArray } from "drizzle-orm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { extractDocument, extractionCategory } from "./extract-text"
import {
	type Connection,
	connectionIngestScope,
	getValidExternalConnection,
} from "./connections"
import { ingestDocument } from "./ingest"
import { assertPublicHttpUrl } from "./safe-fetch"
import { JobExecutionError } from "./background-jobs"
import { requireProviderConsent } from "./provider-consent"

type SyncResult = { provider: string; documents: number; deleted: number }

function connectorFetch(
	input: string | URL | Request,
	init: RequestInit = {},
	signal?: AbortSignal,
) {
	const signals = [signal, init.signal, AbortSignal.timeout(30_000)].filter(
		(value): value is AbortSignal => !!value,
	)
	return fetch(input, {
		...init,
		signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
	})
}

export async function responseJson<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const retryAfter = response.headers.get("retry-after")
		const retryDate = retryAfter ? new Date(retryAfter).getTime() : Number.NaN
		const parsedRetryAfter = retryAfter
			? /^\d+$/.test(retryAfter)
				? Number(retryAfter)
				: Number.isFinite(retryDate)
					? Math.max(1, Math.ceil((retryDate - Date.now()) / 1_000))
					: undefined
			: undefined
		const retryable = response.status === 429 || response.status >= 500
		throw new JobExecutionError(
			`Connector request failed (${response.status}): ${(await response.text()).slice(0, 1_000)}`,
			{ retryable, retryAfterSeconds: parsedRetryAfter },
		)
	}
	return response.json() as Promise<T>
}

async function deleteMissing(connectionId: string, sourceIds: string[]) {
	const rows = await db
		.delete(documents)
		.where(
			and(
				eq(documents.connectionId, connectionId),
				sourceIds.length
					? notInArray(documents.sourceId, sourceIds)
					: undefined,
			),
		)
		.returning({ id: documents.id })
	return rows.length
}

const githubHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
})

async function syncGitHub(
	conn: Connection,
	signal?: AbortSignal,
): Promise<SyncResult> {
	const metadata = conn.metadata as { repositories?: string[] }
	const repositories = metadata.repositories ?? []
	const sourceIds: string[] = []
	let count = 0
	for (const repository of repositories.slice(0, 25)) {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) continue
		const repo = await responseJson<{
			default_branch: string
			html_url: string
		}>(
			await connectorFetch(
				`https://api.github.com/repos/${repository}`,
				{
					headers: githubHeaders(conn.accessToken),
				},
				signal,
			),
		)
		const tree = await responseJson<{
			tree: {
				path: string
				type: string
				sha: string
				size?: number
				url: string
			}[]
			truncated: boolean
		}>(
			await connectorFetch(
				`https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
				{ headers: githubHeaders(conn.accessToken) },
				signal,
			),
		)
		if (tree.truncated)
			throw new Error(`GitHub tree for ${repository} was truncated`)
		const eligibleFiles = tree.tree.filter(
			(item) =>
				item.type === "blob" &&
				(item.size ?? 0) <= 512_000 &&
				/\.(md|mdx|txt|json|ya?ml|tsx?|jsx?|css|html)$/i.test(item.path),
		)
		if (eligibleFiles.length > 500) {
			throw new JobExecutionError(
				`GitHub repository ${repository} has more than 500 eligible files; narrow the configured source before syncing`,
				{ retryable: false },
			)
		}
		const files = eligibleFiles
		for (const file of files) {
			const blob = await responseJson<{ content: string; encoding: string }>(
				await connectorFetch(
					file.url,
					{ headers: githubHeaders(conn.accessToken) },
					signal,
				),
			)
			if (blob.encoding !== "base64") continue
			const sourceId = `${repository}:${file.path}`
			sourceIds.push(sourceId)
			await ingestDocument({
				orgId: conn.orgId,
				connectionId: conn.id,
				...connectionIngestScope(conn),
				source: "github",
				sourceId,
				title: `${repository}/${file.path}`,
				url: `${repo.html_url}/blob/${repo.default_branch}/${file.path}`,
				rawContent: Buffer.from(
					blob.content.replace(/\s/g, ""),
					"base64",
				).toString("utf8"),
				provenance: {
					repository,
					path: file.path,
					ref: repo.default_branch,
					sha: file.sha,
				},
			})
			count += 1
		}
	}
	return {
		provider: "github",
		documents: count,
		deleted: await deleteMissing(conn.id, sourceIds),
	}
}

function collectRichText(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(collectRichText)
	if (!value || typeof value !== "object") return []
	const record = value as Record<string, unknown>
	const output: string[] = []
	if (typeof record.plain_text === "string") output.push(record.plain_text)
	for (const child of Object.values(record))
		output.push(...collectRichText(child))
	return output
}

type NotionBlock = {
	id: string
	has_children?: boolean
	[key: string]: unknown
}

async function notionBlocks(
	pageId: string,
	headers: Record<string, string>,
	depth = 0,
	signal?: AbortSignal,
): Promise<NotionBlock[]> {
	if (depth > 4) return []
	const blocks: NotionBlock[] = []
	let cursor: string | undefined
	for (let page = 0; page < 50; page += 1) {
		const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`)
		url.searchParams.set("page_size", "100")
		if (cursor) url.searchParams.set("start_cursor", cursor)
		const result = await responseJson<{
			results: NotionBlock[]
			has_more: boolean
			next_cursor?: string
		}>(await connectorFetch(url, { headers }, signal))
		blocks.push(...result.results)
		for (const block of result.results) {
			if (block.has_children) {
				blocks.push(
					...(await notionBlocks(block.id, headers, depth + 1, signal)),
				)
			}
		}
		cursor = result.has_more ? result.next_cursor : undefined
		if (!cursor) return blocks
	}
	throw new JobExecutionError("Notion block pagination exceeded 5,000 items", {
		retryable: false,
	})
}

async function syncNotion(
	conn: Connection,
	signal?: AbortSignal,
): Promise<SyncResult> {
	const headers = {
		Authorization: `Bearer ${conn.accessToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	}
	const sourceIds: string[] = []
	let cursor: string | undefined
	let count = 0
	for (let searchPage = 0; searchPage < 50; searchPage += 1) {
		const result = await responseJson<{
			results: {
				id: string
				url: string
				last_edited_time: string
				properties: Record<string, unknown>
			}[]
			has_more: boolean
			next_cursor?: string
		}>(
			await connectorFetch(
				"https://api.notion.com/v1/search",
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						filter: { property: "object", value: "page" },
						page_size: 100,
						start_cursor: cursor,
					}),
				},
				signal,
			),
		)
		for (const page of result.results) {
			const blocks = await notionBlocks(page.id, headers, 0, signal)
			const title =
				collectRichText(page.properties).join(" ").trim() || "Notion page"
			const content = collectRichText(blocks).join("\n").trim()
			if (!content) continue
			sourceIds.push(page.id)
			await ingestDocument({
				orgId: conn.orgId,
				connectionId: conn.id,
				...connectionIngestScope(conn),
				source: "notion",
				sourceId: page.id,
				title,
				url: page.url,
				rawContent: content,
				provenance: { pageId: page.id },
				sourceUpdatedAt: new Date(page.last_edited_time),
			})
			count += 1
		}
		cursor = result.has_more ? result.next_cursor : undefined
		if (!cursor) break
		if (searchPage === 49) {
			throw new JobExecutionError("Notion search exceeded 5,000 pages", {
				retryable: false,
			})
		}
	}
	return {
		provider: "notion",
		documents: count,
		deleted: await deleteMissing(conn.id, sourceIds),
	}
}

async function syncGoogleDrive(
	conn: Connection,
	signal?: AbortSignal,
): Promise<SyncResult> {
	const headers = { Authorization: `Bearer ${conn.accessToken}` }
	const sourceIds: string[] = []
	let pageToken: string | undefined
	let count = 0
	const failures: string[] = []
	for (let page = 0; page < 20; page += 1) {
		const url = new URL("https://www.googleapis.com/drive/v3/files")
		url.searchParams.set("q", "trashed = false")
		url.searchParams.set("pageSize", "100")
		url.searchParams.set(
			"fields",
			"nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size)",
		)
		if (pageToken) url.searchParams.set("pageToken", pageToken)
		const result = await responseJson<{
			nextPageToken?: string
			files: {
				id: string
				name: string
				mimeType: string
				modifiedTime: string
				webViewLink?: string
				size?: string
			}[]
		}>(await connectorFetch(url, { headers }, signal))
		for (const file of result.files) {
			if (Number(file.size ?? 0) > 50 * 1024 * 1024) continue
			const isGoogle = file.mimeType.startsWith("application/vnd.google-apps.")
			const exports: Record<string, { mimeType: string; extension: string }> = {
				"application/vnd.google-apps.document": {
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					extension: ".docx",
				},
				"application/vnd.google-apps.spreadsheet": {
					mimeType:
						"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					extension: ".xlsx",
				},
				"application/vnd.google-apps.presentation": {
					mimeType:
						"application/vnd.openxmlformats-officedocument.presentationml.presentation",
					extension: ".pptx",
				},
				"application/vnd.google-apps.drawing": {
					mimeType: "application/pdf",
					extension: ".pdf",
				},
			}
			const exported = exports[file.mimeType]
			if (isGoogle && !exported) continue
			const contentUrl = exported
				? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exported.mimeType)}`
				: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
			const response = await connectorFetch(contentUrl, { headers }, signal)
			if (!response.ok) await responseJson<never>(response)
			const data = Buffer.from(await response.arrayBuffer())
			if (!data.length || data.length > 50 * 1024 * 1024) continue
			const extensionByMime: Record<string, string> = {
				"application/pdf": ".pdf",
				"text/plain": ".txt",
				"text/markdown": ".md",
				"text/html": ".html",
				"application/json": ".json",
			}
			const fileName = /\.[a-z0-9]{1,8}$/i.test(file.name)
				? file.name
				: `${file.name}${exported?.extension ?? extensionByMime[file.mimeType] ?? ""}`
			const sourceFile = new File([data], fileName, {
				type:
					exported?.mimeType ??
					response.headers.get("content-type")?.split(";")[0] ??
					file.mimeType,
			})
			const category = extractionCategory(sourceFile)
			if (category === "image" || category === "video") {
				await requireProviderConsent({
					orgId: conn.orgId,
					userId: conn.createdBy ?? undefined,
					provider: "openrouter",
					purpose: "media",
				})
			}
			if (category === "audio" || category === "video") {
				await requireProviderConsent({
					orgId: conn.orgId,
					userId: conn.createdBy ?? undefined,
					provider: "openai",
					purpose: "media",
				})
			}
			let extracted: Awaited<ReturnType<typeof extractDocument>>
			try {
				extracted = await extractDocument(sourceFile, signal)
			} catch (error) {
				failures.push(
					`${file.name}: ${error instanceof Error ? error.message : String(error)}`,
				)
				continue
			}
			if (!extracted.text.trim()) continue
			sourceIds.push(file.id)
			await ingestDocument({
				orgId: conn.orgId,
				connectionId: conn.id,
				...connectionIngestScope(conn),
				source: "google_drive",
				sourceId: file.id,
				title: file.name,
				url: file.webViewLink,
				rawContent: extracted.text,
				sections: extracted.sections,
				mimeType: file.mimeType,
				provenance: { driveFileId: file.id, ...extracted.provenance },
				sourceUpdatedAt: new Date(file.modifiedTime),
			})
			count += 1
		}
		pageToken = result.nextPageToken
		if (!pageToken) break
		if (page === 19) {
			throw new JobExecutionError("Google Drive listing exceeded 2,000 files", {
				retryable: false,
			})
		}
	}
	if (failures.length) {
		throw new JobExecutionError(
			`Google Drive extraction failed for ${failures.slice(0, 5).join("; ")}`,
			{ retryable: false },
		)
	}
	return {
		provider: "google_drive",
		documents: count,
		deleted: await deleteMissing(conn.id, sourceIds),
	}
}

async function slack<T>(
	token: string,
	method: string,
	params: Record<string, string> = {},
	signal?: AbortSignal,
) {
	const url = new URL(`https://slack.com/api/${method}`)
	for (const [key, value] of Object.entries(params))
		url.searchParams.set(key, value)
	const payload = await responseJson<T & { ok: boolean; error?: string }>(
		await connectorFetch(
			url,
			{ headers: { Authorization: `Bearer ${token}` } },
			signal,
		),
	)
	if (!payload.ok) {
		const retryable =
			payload.error === "ratelimited" || payload.error === "internal_error"
		throw new JobExecutionError(`Slack ${method} failed: ${payload.error}`, {
			retryable,
		})
	}
	return payload
}

async function syncSlack(
	conn: Connection,
	signal?: AbortSignal,
): Promise<SyncResult> {
	const channelRows: { id: string; name: string; is_archived: boolean }[] = []
	let channelCursor = ""
	for (let page = 0; page < 25; page += 1) {
		const channels = await slack<{
			channels: { id: string; name: string; is_archived: boolean }[]
			response_metadata?: { next_cursor?: string }
		}>(
			conn.accessToken,
			"conversations.list",
			{
				types: "public_channel,private_channel",
				limit: "200",
				...(channelCursor ? { cursor: channelCursor } : {}),
			},
			signal,
		)
		channelRows.push(...channels.channels)
		channelCursor = channels.response_metadata?.next_cursor?.trim() ?? ""
		if (!channelCursor) break
		if (page === 24) {
			throw new JobExecutionError("Slack listing exceeded 5,000 channels", {
				retryable: false,
			})
		}
	}
	const sourceIds: string[] = []
	let count = 0
	for (const channel of channelRows.filter((item) => !item.is_archived)) {
		const messages: { ts: string; text?: string; user?: string }[] = []
		let historyCursor = ""
		for (let page = 0; page < 25; page += 1) {
			const history = await slack<{
				messages: { ts: string; text?: string; user?: string }[]
				response_metadata?: { next_cursor?: string }
			}>(
				conn.accessToken,
				"conversations.history",
				{
					channel: channel.id,
					limit: "200",
					...(historyCursor ? { cursor: historyCursor } : {}),
				},
				signal,
			)
			messages.push(...history.messages)
			historyCursor = history.response_metadata?.next_cursor?.trim() ?? ""
			if (!historyCursor) break
			if (page === 24) {
				throw new JobExecutionError(
					`Slack history for #${channel.name} exceeded 5,000 messages`,
					{ retryable: false },
				)
			}
		}
		const content = messages
			.slice()
			.reverse()
			.map(
				(message) =>
					`[${message.ts}] ${message.user ?? "unknown"}: ${message.text ?? ""}`,
			)
			.join("\n")
		if (!content.trim()) continue
		sourceIds.push(channel.id)
		await ingestDocument({
			orgId: conn.orgId,
			connectionId: conn.id,
			...connectionIngestScope(conn),
			source: "slack",
			sourceId: channel.id,
			title: `#${channel.name}`,
			rawContent: content,
			provenance: { channelId: channel.id },
			sourceUpdatedAt: messages[0]?.ts
				? new Date(Number(messages[0].ts) * 1_000)
				: undefined,
		})
		count += 1
	}
	return {
		provider: "slack",
		documents: count,
		deleted: await deleteMissing(conn.id, sourceIds),
	}
}

async function syncMcp(
	conn: Connection,
	signal?: AbortSignal,
): Promise<SyncResult> {
	const metadata = conn.metadata as { baseUrl?: string }
	if (!metadata.baseUrl)
		throw new Error("Remote MCP connection has no base URL")
	const url = await assertPublicHttpUrl(metadata.baseUrl)
	const allowlist = new Set(
		(process.env.OUTBOUND_MCP_ALLOWLIST ?? "")
			.split(",")
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean),
	)
	if (!allowlist.has(url.hostname.toLowerCase())) {
		throw new Error(`Remote MCP host ${url.hostname} is not allowlisted`)
	}
	const transport = new StreamableHTTPClientTransport(url, {
		fetch: async (input, init) => {
			const target = await assertPublicHttpUrl(
				typeof input === "string" ? input : input.toString(),
			)
			if (target.origin !== url.origin) {
				throw new Error(
					"Remote MCP requests cannot leave the allowlisted origin",
				)
			}
			return connectorFetch(target, { ...init, redirect: "error" }, signal)
		},
		requestInit: {
			headers: conn.accessToken
				? { Authorization: `Bearer ${conn.accessToken}` }
				: undefined,
		},
	})
	const client = new Client({ name: "context-layer", version: "0.1.0" })
	await client.connect(transport)
	const sourceIds: string[] = []
	let count = 0
	try {
		let cursor: string | undefined
		for (let page = 0; page < 20; page += 1) {
			const listed = await client.listResources(cursor ? { cursor } : undefined)
			if (sourceIds.length + listed.resources.length > 500) {
				throw new JobExecutionError(
					"Remote MCP exposes more than 500 resources",
					{
						retryable: false,
					},
				)
			}
			for (const resource of listed.resources) {
				const read = await client.readResource({ uri: resource.uri })
				const content = read.contents
					.map((item) =>
						"text" in item
							? item.text
							: "blob" in item
								? Buffer.from(item.blob, "base64").toString("utf8")
								: "",
					)
					.join("\n\n")
				if (!content.trim()) continue
				sourceIds.push(resource.uri)
				await ingestDocument({
					orgId: conn.orgId,
					connectionId: conn.id,
					...connectionIngestScope(conn),
					source: "url",
					sourceId: resource.uri,
					title: resource.name,
					url: resource.uri.startsWith("http") ? resource.uri : undefined,
					rawContent: content,
					mimeType: resource.mimeType,
					provenance: { mcpServer: url.origin, resourceUri: resource.uri },
				})
				count += 1
			}
			cursor = listed.nextCursor
			if (!cursor) break
		}
	} finally {
		await client.close()
	}
	return {
		provider: "mcp",
		documents: count,
		deleted: await deleteMissing(conn.id, sourceIds),
	}
}

export async function syncExternalConnection(
	connectionId: string,
	signal?: AbortSignal,
) {
	const [row] = await db
		.select({ orgId: connections.orgId, provider: connections.provider })
		.from(connections)
		.where(eq(connections.id, connectionId))
		.limit(1)
	if (!row) throw new Error("Connection not found")
	const conn = await getValidExternalConnection(row.orgId, row.provider)
	if (!conn) throw new Error("Connection not found")
	try {
		let result: SyncResult
		switch (conn.provider) {
			case "github":
				result = await syncGitHub(conn, signal)
				break
			case "notion":
				result = await syncNotion(conn, signal)
				break
			case "google_drive":
				result = await syncGoogleDrive(conn, signal)
				break
			case "slack":
				result = await syncSlack(conn, signal)
				break
			case "mcp":
				result = await syncMcp(conn, signal)
				break
			default:
				throw new Error(
					`Provider ${conn.provider} uses its dedicated sync adapter`,
				)
		}
		await db
			.insert(connectorCursors)
			.values({ connectionId, lastSyncedAt: new Date(), lastError: null })
			.onConflictDoUpdate({
				target: connectorCursors.connectionId,
				set: {
					lastSyncedAt: new Date(),
					lastError: null,
					updatedAt: new Date(),
				},
			})
		return result
	} catch (error) {
		await db
			.insert(connectorCursors)
			.values({
				connectionId,
				lastError: error instanceof Error ? error.message : String(error),
			})
			.onConflictDoUpdate({
				target: connectorCursors.connectionId,
				set: {
					lastError: error instanceof Error ? error.message : String(error),
					updatedAt: new Date(),
				},
			})
		throw error
	}
}
