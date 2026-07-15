import { expect, test } from "bun:test"
import JSZip from "jszip"
import { extractDocument, extractionCategory } from "./extract-text"

test("extracts text formats without executable HTML content", async () => {
	const result = await extractDocument(
		new File(
			[
				"<main><h1>Product brief</h1><p>Visible requirement</p><script>privateToken</script><style>.secret{}</style></main>",
			],
			"brief.html",
		),
	)
	expect(result.text).toContain("Product brief")
	expect(result.text).toContain("Visible requirement")
	expect(result.text).not.toContain("privateToken")
	expect(result.text).not.toContain(".secret")
})

test("extracts DOCX document text with format provenance", async () => {
	const zip = new JSZip()
	zip.file(
		"word/document.xml",
		"<w:document><w:body><w:p><w:r><w:t>Research finding</w:t></w:r></w:p></w:body></w:document>",
	)
	const result = await extractDocument(
		new File([await zip.generateAsync({ type: "uint8array" })], "notes.docx"),
	)
	expect(result.text).toContain("Research finding")
	expect(result.sections?.[0]?.provenance).toEqual({ format: "docx" })
})

test("extracts ordered PPTX slides with slide provenance", async () => {
	const zip = new JSZip()
	zip.file("ppt/slides/slide2.xml", "<p:sld><a:t>Second screen</a:t></p:sld>")
	zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>First screen</a:t></p:sld>")
	const result = await extractDocument(
		new File([await zip.generateAsync({ type: "uint8array" })], "flow.pptx"),
	)
	expect(result.text.indexOf("First screen")).toBeLessThan(
		result.text.indexOf("Second screen"),
	)
	expect(result.sections?.map((section) => section.provenance.slide)).toEqual([
		1, 2,
	])
})

test("extracts named XLSX sheets and resolves shared strings", async () => {
	const zip = new JSZip()
	zip.file(
		"xl/workbook.xml",
		'<workbook xmlns:r="r"><sheets><sheet name="Roadmap" r:id="rId1"/></sheets></workbook>',
	)
	zip.file(
		"xl/_rels/workbook.xml.rels",
		'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
	)
	zip.file(
		"xl/sharedStrings.xml",
		"<sst><si><t>Feature</t></si><si><t>Canvas</t></si></sst>",
	)
	zip.file(
		"xl/worksheets/sheet1.xml",
		'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
	)
	const file = new File(
		[await zip.generateAsync({ type: "uint8array" })],
		"plan.xlsx",
	)
	const result = await extractDocument(file)

	expect(result.text).toContain("Roadmap")
	expect(result.text).toContain("A1: Feature")
	expect(result.text).toContain("B1: Canvas")
	expect(result.sections?.[0]?.provenance).toEqual({
		format: "xlsx",
		sheet: 1,
		sheetName: "Roadmap",
	})
})

test("classifies image, audio, video, and document inputs", () => {
	expect(extractionCategory(new File([], "screen.png"))).toBe("image")
	expect(extractionCategory(new File([], "interview.mp3"))).toBe("audio")
	expect(extractionCategory(new File([], "walkthrough.mp4"))).toBe("video")
	expect(extractionCategory(new File([], "brief.pdf"))).toBe("document")
})
