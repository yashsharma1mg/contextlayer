import { expect, test } from "bun:test"
import { isAllowedRepositoryFile, isRepositoryPath } from "./github-publication"

test("only allows repository-relative publication paths", () => {
	expect(isRepositoryPath("apps/web")).toBe(true)
	expect(isRepositoryPath("../secrets")).toBe(false)
	expect(isRepositoryPath("/tmp/output")).toBe(false)
})

test("allows generated files beneath the configured repository roots", () => {
	expect(isAllowedRepositoryFile("src/App.tsx", ".", [])).toBe(true)
	expect(isAllowedRepositoryFile("src/App.tsx", "apps/web", [])).toBe(true)
	expect(
		isAllowedRepositoryFile("src/App.tsx", "apps/web", ["apps/admin"]),
	).toBe(false)
	expect(isAllowedRepositoryFile("../secrets", ".", [])).toBe(false)
})
