export function requireMcpScope(scopes: ReadonlySet<string>, scope: string) {
	if (!scopes.has(scope)) throw new Error(`MCP scope required: ${scope}`)
}
