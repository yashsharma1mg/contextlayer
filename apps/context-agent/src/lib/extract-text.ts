import pdfParse from "pdf-parse"

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json"])

/**
 * Text extraction for generic uploads — not tied to any connector, this is
 * what makes "read across all the data the user sends or uploads" real
 * rather than just accepting pre-extracted strings. Only formats we can
 * reliably get real text out of; anything else is rejected explicitly
 * rather than embedding garbage decoded-as-UTF8 binary content.
 */
export async function extractText(file: File): Promise<string> {
	const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
	const buffer = Buffer.from(await file.arrayBuffer())

	if (ext === "pdf") {
		const { text } = await pdfParse(buffer)
		return text
	}
	if (TEXT_EXTENSIONS.has(ext)) {
		return buffer.toString("utf-8")
	}
	throw new Error(
		`Unsupported file type: .${ext || "unknown"}. Supported: ${[...TEXT_EXTENSIONS, "pdf"].join(", ")}.`,
	)
}
