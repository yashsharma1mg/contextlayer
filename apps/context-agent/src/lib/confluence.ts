const AUTHORIZE_URL = "https://auth.atlassian.com/authorize"
const TOKEN_URL = "https://auth.atlassian.com/oauth/token"
const ACCESSIBLE_RESOURCES_URL =
	"https://api.atlassian.com/oauth/token/accessible-resources"

// offline_access is required to get a refresh_token back.
const SCOPES = [
	"read:confluence-content.all",
	"read:confluence-space.summary",
	"search:confluence",
	"offline_access",
].join(" ")

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init)
	if (!res.ok) {
		throw new Error(
			`Confluence request failed (${url}): ${res.status} ${await res.text()}`,
		)
	}
	return res.json() as Promise<T>
}

const authHeader = (accessToken: string) => ({
	Authorization: `Bearer ${accessToken}`,
})

export function getAuthorizeUrl(state: string): string {
	const params = new URLSearchParams({
		audience: "api.atlassian.com",
		client_id: process.env.CONFLUENCE_CLIENT_ID as string,
		scope: SCOPES,
		redirect_uri: process.env.CONFLUENCE_REDIRECT_URI as string,
		state,
		response_type: "code",
		prompt: "consent",
	})
	return `${AUTHORIZE_URL}?${params}`
}

interface TokenResponse {
	access_token: string
	refresh_token: string
	expires_in: number
}

const postToken = (body: Record<string, string>) =>
	fetchJson<TokenResponse>(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: process.env.CONFLUENCE_CLIENT_ID,
			client_secret: process.env.CONFLUENCE_CLIENT_SECRET,
			...body,
		}),
	})

export const exchangeCodeForToken = (code: string) =>
	postToken({
		grant_type: "authorization_code",
		code,
		redirect_uri: process.env.CONFLUENCE_REDIRECT_URI as string,
	})

export const refreshAccessToken = (refreshToken: string) =>
	postToken({ grant_type: "refresh_token", refresh_token: refreshToken })

interface AccessibleResource {
	id: string
	url: string
	name: string
}

/** A 3LO app can be authorized for multiple sites; MVP assumes one Confluence site per org. */
export const getAccessibleSites = (accessToken: string) =>
	fetchJson<AccessibleResource[]>(ACCESSIBLE_RESOURCES_URL, {
		headers: authHeader(accessToken),
	})

const apiBase = (cloudId: string) =>
	`https://api.atlassian.com/ex/confluence/${cloudId}`

export interface ConfluenceSpace {
	id: string
	key: string
	name: string
}

interface PaginatedResponse<T> {
	results: T[]
	_links?: { next?: string }
}

/**
 * Global (team) spaces only — personal spaces are skipped for MVP since
 * attributing them to our app's userId needs an identity-linking step
 * (Confluence account id -> our user) that doesn't exist yet. Ingesting them
 * with the wrong owner would be a real correctness bug, not a nice-to-have.
 */
export async function listGlobalSpaces(
	cloudId: string,
	accessToken: string,
): Promise<ConfluenceSpace[]> {
	const spaces: ConfluenceSpace[] = []
	let url: string | undefined =
		`${apiBase(cloudId)}/wiki/api/v2/spaces?type=global&status=current&limit=100`
	while (url) {
		const data: PaginatedResponse<ConfluenceSpace> = await fetchJson(url, {
			headers: authHeader(accessToken),
		})
		spaces.push(
			...data.results.map((s) => ({ id: s.id, key: s.key, name: s.name })),
		)
		url = data._links?.next
			? `https://api.atlassian.com${data._links.next}`
			: undefined
	}
	return spaces
}

export interface ConfluencePage {
	id: string
	title: string
	url: string
	adfBody: unknown
	updatedAt: string
}

interface RawPage {
	id: string
	title: string
	_links: { base: string; webui: string }
	body: { atlas_doc_format: { value: string } }
	version: { createdAt: string }
}

const toConfluencePage = (p: RawPage): ConfluencePage => ({
	id: p.id,
	title: p.title,
	url: `${p._links.base}${p._links.webui}`,
	adfBody: JSON.parse(p.body.atlas_doc_format.value),
	updatedAt: p.version.createdAt,
})

const fetchPage = async (
	cloudId: string,
	accessToken: string,
	pageId: string,
) =>
	toConfluencePage(
		await fetchJson<RawPage>(
			`${apiBase(cloudId)}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`,
			{ headers: authHeader(accessToken) },
		),
	)

/** Every page in a space, paginated. Used for first-time backfill of a space. */
export async function listAllPages(
	cloudId: string,
	accessToken: string,
	spaceId: string,
): Promise<ConfluencePage[]> {
	const pages: ConfluencePage[] = []
	let url: string | undefined =
		`${apiBase(cloudId)}/wiki/api/v2/spaces/${spaceId}/pages?status=current&limit=100&body-format=atlas_doc_format`
	while (url) {
		const data: PaginatedResponse<RawPage> = await fetchJson(url, {
			headers: authHeader(accessToken),
		})
		pages.push(...data.results.map(toConfluencePage))
		url = data._links?.next
			? `https://api.atlassian.com${data._links.next}`
			: undefined
	}
	return pages
}

/**
 * Pages changed since a given time. No webhook support exists for 3LO apps
 * (confirmed against Atlassian's own docs), so incremental sync is CQL
 * polling via the v1 search endpoint rather than push notifications.
 */
export async function findPagesUpdatedSince(
	cloudId: string,
	accessToken: string,
	spaceKey: string,
	since: Date,
): Promise<ConfluencePage[]> {
	const cqlDate = since.toISOString().slice(0, 16).replace("T", " ")
	const cql = `space = "${spaceKey}" and type = page and lastmodified > "${cqlDate}"`
	const url = `${apiBase(cloudId)}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=100`
	const data = await fetchJson<{ results: { content: { id: string } }[] }>(
		url,
		{
			headers: authHeader(accessToken),
		},
	)
	return Promise.all(
		data.results.map((r) => fetchPage(cloudId, accessToken, r.content.id)),
	)
}

/** Flattens Atlassian Document Format JSON into plain text for chunking/embedding. */
export function adfToText(node: unknown): string {
	if (!node || typeof node !== "object") return ""
	const n = node as { type?: string; text?: string; content?: unknown[] }
	if (n.type === "text") return n.text ?? ""
	if (!Array.isArray(n.content)) return ""
	const isBlock = n.type === "paragraph" || n.type?.startsWith("heading")
	return n.content.map(adfToText).join(isBlock ? "\n" : " ")
}
