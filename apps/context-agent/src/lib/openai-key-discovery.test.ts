import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverOpenAiKey, maskKey } from "./openai-key-discovery"

let scratch = ""
let savedKey: string | undefined

beforeEach(() => {
	savedKey = process.env.OPENAI_API_KEY
	delete process.env.OPENAI_API_KEY
	scratch = mkdtempSync(join(tmpdir(), "contextlayer-codex-"))
})

afterEach(() => {
	if (savedKey === undefined) delete process.env.OPENAI_API_KEY
	else process.env.OPENAI_API_KEY = savedKey
})

function codexAuth(contents: unknown) {
	const path = join(scratch, "auth.json")
	writeFileSync(path, JSON.stringify(contents))
	return path
}

test("a ChatGPT-mode Codex install offers nothing", () => {
	// The boundary that matters: these are OAuth tokens issued to Codex's own
	// client against the user's ChatGPT plan, not an API key. Spending them here
	// would be using a subscription outside the product it was sold for.
	const path = codexAuth({
		auth_mode: "chatgpt",
		OPENAI_API_KEY: null,
		tokens: {
			access_token: "should-never-be-read",
			refresh_token: "should-never-be-read",
		},
	})
	expect(discoverOpenAiKey(path)).toBeNull()
})

test("a ChatGPT-mode install is refused even if a key sits beside the tokens", () => {
	const path = codexAuth({ auth_mode: "chatgpt", OPENAI_API_KEY: "sk-nope" })
	expect(discoverOpenAiKey(path)).toBeNull()
})

test("an unrecognised auth mode fails closed", () => {
	const path = codexAuth({ auth_mode: "something-new", OPENAI_API_KEY: "sk-x" })
	expect(discoverOpenAiKey(path)).toBeNull()
})

test("an api-key Codex install offers its key", () => {
	const path = codexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-real-key" })
	expect(discoverOpenAiKey(path)).toEqual({
		key: "sk-real-key",
		origin: "~/.codex/auth.json",
	})
})

test("the environment wins over a Codex install", () => {
	process.env.OPENAI_API_KEY = "sk-env"
	const path = codexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-codex" })
	expect(discoverOpenAiKey(path)).toEqual({
		key: "sk-env",
		origin: "OPENAI_API_KEY",
	})
})

test("a missing Codex install is not an error", () => {
	expect(discoverOpenAiKey(join(scratch, "absent.json"))).toBeNull()
})

test("the preview reveals only the ends of the key", () => {
	const masked = maskKey("sk-proj-abcdefghijklmnop")
	expect(masked).toBe("sk-…mnop")
	expect(masked).not.toContain("abcdefghij")
})
