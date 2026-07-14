import { expect, test } from "bun:test"
import { isRepositoryPath } from "./github-publication"

test("only allows repository-relative publication paths", () => {
	expect(isRepositoryPath("apps/web")).toBe(true)
	expect(isRepositoryPath("../secrets")).toBe(false)
	expect(isRepositoryPath("/tmp/output")).toBe(false)
})
