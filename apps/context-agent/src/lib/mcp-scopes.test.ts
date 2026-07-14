import { describe, expect, test } from "bun:test"
import { requireMcpScope } from "./mcp-scopes"

describe("MCP scopes", () => {
	test("read-only tokens cannot use write tools", () => {
		const scopes = new Set(["knowledge:read", "canvas:read", "design:read"])

		expect(() => requireMcpScope(scopes, "knowledge:read")).not.toThrow()
		expect(() => requireMcpScope(scopes, "generation:write")).toThrow(
			"MCP scope required: generation:write",
		)
		expect(() => requireMcpScope(scopes, "publication:write")).toThrow(
			"MCP scope required: publication:write",
		)
	})
})
