export type OAuthProvider = "github" | "notion" | "google_drive" | "slack"

type TokenResult = {
	accessToken: string
	refreshToken: string
	expiresAt: Date | null
	accountId: string
	metadata: Record<string, unknown>
}

export type RefreshedConnectorToken = {
	accessToken: string
	refreshToken?: string
	expiresAt: Date | null
}

function required(name: string) {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	return value
}

function callback(provider: OAuthProvider) {
	return `${required("BETTER_AUTH_URL")}/api/connections/${provider}/callback`
}

const credentials = (provider: OAuthProvider) => ({
	clientId: required(`${provider.toUpperCase()}_CLIENT_ID`),
	clientSecret: required(`${provider.toUpperCase()}_CLIENT_SECRET`),
})

export function connectorAuthorizeUrl(provider: OAuthProvider, state: string) {
	const { clientId } = credentials(provider)
	const definitions: Record<
		OAuthProvider,
		{ url: string; params: Record<string, string> }
	> = {
		github: {
			url: "https://github.com/login/oauth/authorize",
			params: { client_id: clientId, scope: "repo read:user" },
		},
		notion: {
			url: "https://api.notion.com/v1/oauth/authorize",
			params: { client_id: clientId, response_type: "code", owner: "user" },
		},
		google_drive: {
			url: "https://accounts.google.com/o/oauth2/v2/auth",
			params: {
				client_id: clientId,
				response_type: "code",
				access_type: "offline",
				prompt: "consent",
				scope: "openid email https://www.googleapis.com/auth/drive.readonly",
			},
		},
		slack: {
			url: "https://slack.com/oauth/v2/authorize",
			params: {
				client_id: clientId,
				scope: "channels:read,channels:history,groups:read,groups:history",
			},
		},
	}
	const definition = definitions[provider]
	const url = new URL(definition.url)
	for (const [key, value] of Object.entries({
		...definition.params,
		redirect_uri: callback(provider),
		state,
	})) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

async function json<T>(response: Response): Promise<T> {
	if (!response.ok) {
		throw new Error(
			`OAuth request failed (${response.status}): ${await response.text()}`,
		)
	}
	return response.json() as Promise<T>
}

export async function exchangeConnectorCode(
	provider: OAuthProvider,
	code: string,
): Promise<TokenResult> {
	const { clientId, clientSecret } = credentials(provider)
	if (provider === "github") {
		const token = await json<{
			access_token: string
			refresh_token?: string
			expires_in?: number
		}>(
			await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					client_id: clientId,
					client_secret: clientSecret,
					code,
					redirect_uri: callback(provider),
				}),
			}),
		)
		const user = await json<{ id: number; login: string }>(
			await fetch("https://api.github.com/user", {
				headers: {
					Authorization: `Bearer ${token.access_token}`,
					Accept: "application/vnd.github+json",
				},
			}),
		)
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? "",
			expiresAt: token.expires_in
				? new Date(Date.now() + token.expires_in * 1_000)
				: null,
			accountId: String(user.id),
			metadata: { login: user.login, repositories: [] },
		}
	}
	if (provider === "notion") {
		const token = await json<{
			access_token: string
			refresh_token?: string
			workspace_id: string
			workspace_name?: string
			bot_id?: string
		}>(
			await fetch("https://api.notion.com/v1/oauth/token", {
				method: "POST",
				headers: {
					Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					grant_type: "authorization_code",
					code,
					redirect_uri: callback(provider),
				}),
			}),
		)
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? "",
			expiresAt: null,
			accountId: token.workspace_id,
			metadata: {
				workspaceName: token.workspace_name,
				botId: token.bot_id,
			},
		}
	}
	if (provider === "google_drive") {
		const body = new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: callback(provider),
		})
		const token = await json<{
			access_token: string
			refresh_token?: string
			expires_in: number
		}>(
			await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			}),
		)
		const profile = await json<{ id: string; email: string }>(
			await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
				headers: { Authorization: `Bearer ${token.access_token}` },
			}),
		)
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? "",
			expiresAt: new Date(Date.now() + token.expires_in * 1_000),
			accountId: profile.id,
			metadata: { email: profile.email },
		}
	}

	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: callback(provider),
	})
	const token = await json<{
		ok: boolean
		access_token: string
		refresh_token?: string
		expires_in?: number
		team: { id: string; name: string }
	}>(
		await fetch("https://slack.com/api/oauth.v2.access", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		}),
	)
	if (!token.ok) throw new Error("Slack rejected the OAuth exchange")
	return {
		accessToken: token.access_token,
		refreshToken: token.refresh_token ?? "",
		expiresAt: token.expires_in
			? new Date(Date.now() + token.expires_in * 1_000)
			: null,
		accountId: token.team.id,
		metadata: { teamName: token.team.name },
	}
}

export async function refreshConnectorToken(
	provider: OAuthProvider,
	refreshToken: string,
): Promise<RefreshedConnectorToken> {
	if (!refreshToken)
		throw new Error(`${provider} connection must be reconnected`)
	const { clientId, clientSecret } = credentials(provider)
	if (provider === "google_drive") {
		const token = await json<{ access_token: string; expires_in: number }>(
			await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				}),
			}),
		)
		return {
			accessToken: token.access_token,
			expiresAt: new Date(Date.now() + token.expires_in * 1_000),
		}
	}

	const endpoint =
		provider === "github"
			? "https://github.com/login/oauth/access_token"
			: provider === "notion"
				? "https://api.notion.com/v1/oauth/token"
				: "https://slack.com/api/oauth.v2.access"
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	}
	if (provider === "notion") {
		headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
	}
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	})
	if (provider !== "notion") {
		body.set("client_id", clientId)
		body.set("client_secret", clientSecret)
	}
	const token = await json<{
		ok?: boolean
		access_token: string
		refresh_token?: string
		expires_in?: number
	}>(await fetch(endpoint, { method: "POST", headers, body }))
	if (token.ok === false)
		throw new Error(`${provider} rejected the token refresh`)
	return {
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		expiresAt: token.expires_in
			? new Date(Date.now() + token.expires_in * 1_000)
			: null,
	}
}
