import { expect, test } from "bun:test"
import { redactCaptureOutline } from "./capture-redaction"

test("redacts sensitive structured capture data", () => {
	const result = redactCaptureOutline(
		JSON.stringify({
			label: "Sign in",
			value: "visible-but-sensitive",
			child: { authorization: "Bearer secret-value" },
		}),
	)
	expect(result).not.toContain("visible-but-sensitive")
	expect(result).not.toContain("secret-value")
	expect(result).toContain("[REDACTED]")
})

test("redacts sensitive fallback text", () => {
	const result = redactCaptureOutline("token=secret-value, page=Settings")
	expect(result).toContain("token=[REDACTED]")
	expect(result).not.toContain("secret-value")
})
