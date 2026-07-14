const AUTHORIZE_URL = "https://www.figma.com/oauth"
const TOKEN_URL = "https://api.figma.com/v1/oauth/token"
const REFRESH_URL = "https://api.figma.com/v1/oauth/refresh"
const API_BASE = "https://api.figma.com/v1"

// Read-only for now — no file_comments:write until the human-reviewed
// write-back phase actually exists.
const SCOPES = [
	"file_content:read",
	"file_comments:read",
	"current_user:read",
].join(",")

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init)
	if (!res.ok) {
		throw new Error(
			`Figma request failed (${url}): ${res.status} ${await res.text()}`,
		)
	}
	return res.json() as Promise<T>
}

const basicAuthHeader = () =>
	`Basic ${Buffer.from(
		`${process.env.FIGMA_CLIENT_ID}:${process.env.FIGMA_CLIENT_SECRET}`,
	).toString("base64")}`

export function getAuthorizeUrl(state: string): string {
	const params = new URLSearchParams({
		client_id: process.env.FIGMA_CLIENT_ID as string,
		redirect_uri: process.env.FIGMA_REDIRECT_URI as string,
		scope: SCOPES,
		state,
		response_type: "code",
	})
	return `${AUTHORIZE_URL}?${params}`
}

interface TokenResponse {
	access_token: string
	refresh_token: string
	expires_in: number
	user_id_string: string
}

export const exchangeCodeForToken = (code: string) =>
	fetchJson<TokenResponse>(TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: basicAuthHeader(),
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			redirect_uri: process.env.FIGMA_REDIRECT_URI as string,
			code,
			grant_type: "authorization_code",
		}),
	})

// Figma's refresh does NOT return a new refresh_token — the original stays valid.
export const refreshAccessToken = (refreshToken: string) =>
	fetchJson<{ access_token: string; expires_in: number }>(REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: basicAuthHeader(),
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ refresh_token: refreshToken }),
	})

const authHeader = (accessToken: string) => ({
	Authorization: `Bearer ${accessToken}`,
})

export const getCurrentUser = (accessToken: string) =>
	fetchJson<{ id: string; email: string; handle: string }>(`${API_BASE}/me`, {
		headers: authHeader(accessToken),
	})

interface FigmaNode {
	id: string
	name: string
	type: string
	description?: string
	children?: FigmaNode[]
}

export interface FigmaFile {
	name: string
	lastModified: string
	document: FigmaNode
}

export const getFile = (fileKey: string, accessToken: string) =>
	fetchJson<FigmaFile>(`${API_BASE}/files/${fileKey}`, {
		headers: authHeader(accessToken),
	})

// Figma's message field shape isn't consistently documented (plain string in
// some API versions, structured fragments in others) — handle both rather
// than assume, since guessing wrong here silently drops comment content.
type CommentMessage = string | { text?: string }[]

export interface FigmaComment {
	id: string
	message: CommentMessage
	parent_id: string
	created_at: string
	resolved_at: string | null
	order_id: number | null
}

export const getFileComments = (fileKey: string, accessToken: string) =>
	fetchJson<{ comments: FigmaComment[] }>(
		`${API_BASE}/files/${fileKey}/comments`,
		{
			headers: authHeader(accessToken),
		},
	).then((r) => r.comments)

export function commentMessageToText(message: CommentMessage): string {
	if (typeof message === "string") return message
	return message.map((m) => m.text ?? "").join("")
}

export interface ComponentDescription {
	nodeId: string
	name: string
	description: string
}

/** Walks the file's node tree collecting non-empty descriptions on components. */
export function extractComponentDescriptions(
	node: FigmaNode,
): ComponentDescription[] {
	const results: ComponentDescription[] = []
	const walk = (n: FigmaNode) => {
		if (
			(n.type === "COMPONENT" || n.type === "COMPONENT_SET") &&
			n.description?.trim()
		) {
			results.push({ nodeId: n.id, name: n.name, description: n.description })
		}
		n.children?.forEach(walk)
	}
	walk(node)
	return results
}

/** Extracts the file key from a figma.com/file/... or /design/... URL. */
export function parseFileKey(url: string): string | null {
	const match = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/)
	return match ? (match[1] as string) : null
}
