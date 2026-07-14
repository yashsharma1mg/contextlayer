import { expect, test } from "bun:test"
import { captureOutlineText, redactCaptureOutline } from "./capture-redaction"

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

test("removes text copied from protected descendants", () => {
	const result = JSON.parse(
		redactCaptureOutline(
			JSON.stringify({
				tag: "form",
				text: "Visible label private draft",
				children: [
					{ tag: "label", text: "Visible label" },
					{ tag: "div", redacted: true, text: "private draft" },
				],
			}),
		),
	) as { text?: string; children: Array<{ text?: string }> }

	expect(result.text).toBeUndefined()
	expect(result.children[1]?.text).toBeUndefined()
})

test("extracts searchable capture text without protected controls", () => {
	const text = captureOutlineText(
		JSON.stringify({
			root: {
				tag: "main",
				label: "Checkout",
				children: [
					{ tag: "h1", text: "Confirm order" },
					{ tag: "input", text: "card 4242", redacted: true },
				],
			},
		}),
	)
	expect(text).toContain("Checkout")
	expect(text).toContain("Confirm order")
	expect(text).not.toContain("4242")
})
