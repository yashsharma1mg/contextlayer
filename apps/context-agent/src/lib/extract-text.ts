import { XMLParser } from "fast-xml-parser"
import JSZip from "jszip"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, posix } from "node:path"
import pdfParse from "pdf-parse"

const TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"csv",
	"tsv",
	"json",
	"yaml",
	"yml",
	"html",
	"htm",
])
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"])
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "aac", "ogg", "flac"])
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm"])
const MAX_ARCHIVE_ENTRIES = 5_000
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

export interface ExtractedDocument {
	text: string
	provenance: Record<string, unknown>
	sections?: { text: string; provenance: Record<string, unknown> }[]
	derived?: {
		kind: "media_keyframe"
		data: Uint8Array
		mimeType: string
		metadata: Record<string, unknown>
	}[]
}

const records = new XMLParser({ ignoreAttributes: false, trimValues: true })

function array<T>(value: T | T[] | undefined): T[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

const xml = new XMLParser({
	ignoreAttributes: false,
	preserveOrder: true,
	trimValues: true,
})

function textFromXml(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(textFromXml)
	if (!value || typeof value !== "object") return []
	const output: string[] = []
	for (const [key, child] of Object.entries(value)) {
		if (
			["script", "style", "noscript", "template"].includes(key.toLowerCase())
		) {
			continue
		}
		if (
			key === "#text" &&
			(typeof child === "string" || typeof child === "number")
		) {
			output.push(String(child))
		} else if (key !== ":@") output.push(...textFromXml(child))
	}
	return output
}

function textFromRecord(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(textFromRecord)
	if (typeof value === "string" || typeof value === "number")
		return [String(value)]
	if (!value || typeof value !== "object") return []
	return Object.entries(value).flatMap(([key, child]) =>
		key.startsWith("@_") ? [] : textFromRecord(child),
	)
}

async function safeZip(buffer: Buffer) {
	if (buffer.byteLength > 50 * 1024 * 1024) {
		throw new Error("Office archive exceeds the 50 MB compressed limit")
	}
	const zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
	const entries = Object.values(zip.files)
	if (entries.length > MAX_ARCHIVE_ENTRIES) {
		throw new Error("Office archive contains too many files")
	}
	let expanded = 0
	for (const entry of entries) {
		const size = (entry as unknown as { _data?: { uncompressedSize?: number } })
			._data?.uncompressedSize
		expanded += size ?? 0
		if (expanded > MAX_ARCHIVE_BYTES) {
			throw new Error("Office archive expands beyond the 200 MB safety limit")
		}
	}
	return zip
}

async function officeXmlText(buffer: Buffer, paths: string[]) {
	const zip = await safeZip(buffer)
	const sections: string[] = []
	for (const path of paths) {
		const entry = zip.file(path)
		if (!entry) continue
		const content = await entry.async("string")
		const text = textFromXml(xml.parse(content)).join(" ").replace(/\s+/g, " ")
		if (text) sections.push(text)
	}
	return sections
}

async function xlsxSections(buffer: Buffer) {
	const zip = await safeZip(buffer)
	const parsed = async (path: string) => {
		const entry = zip.file(path)
		return entry ? records.parse(await entry.async("string")) : null
	}
	const sharedDocument = await parsed("xl/sharedStrings.xml")
	const sharedStrings = array(sharedDocument?.sst?.si).map((value) =>
		textFromRecord(value).join(""),
	)
	const workbook = await parsed("xl/workbook.xml")
	const relationships = await parsed("xl/_rels/workbook.xml.rels")
	const targets = new Map(
		array(relationships?.Relationships?.Relationship).map((relationship) => [
			String(relationship["@_Id"]),
			String(relationship["@_Target"]),
		]),
	)
	const sheets = array(workbook?.workbook?.sheets?.sheet)
	const fallbackPaths = Object.keys(zip.files)
		.filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
		.sort((left, right) =>
			left.localeCompare(right, undefined, { numeric: true }),
		)
	const definitions = sheets.length
		? sheets.map((sheet, index) => ({
				name: String(sheet["@_name"] ?? `Sheet ${index + 1}`),
				path: posix.normalize(
					posix.join("xl", targets.get(String(sheet["@_r:id"])) ?? ""),
				),
			}))
		: fallbackPaths.map((path, index) => ({ name: `Sheet ${index + 1}`, path }))
	const sections: { text: string; provenance: Record<string, unknown> }[] = []
	for (const [index, definition] of definitions.entries()) {
		if (!definition.path.startsWith("xl/worksheets/")) continue
		const sheet = await parsed(definition.path)
		const rows = array(sheet?.worksheet?.sheetData?.row)
			.map((row) =>
				array(row.c)
					.map((cell) => {
						const type = cell["@_t"]
						const raw = cell.v ?? textFromRecord(cell.is).join("")
						const value = type === "s" ? sharedStrings[Number(raw)] : raw
						return value === undefined
							? null
							: `${cell["@_r"] ?? "cell"}: ${String(value)}`
					})
					.filter(Boolean)
					.join("\t"),
			)
			.filter(Boolean)
		sections.push({
			text: `${definition.name}\n${rows.join("\n")}`,
			provenance: {
				format: "xlsx",
				sheet: index + 1,
				sheetName: definition.name,
			},
		})
	}
	return sections
}

async function describeImage(
	data: Buffer,
	mimeType: string,
	signal?: AbortSignal,
) {
	const key = process.env.OPENROUTER_API_KEY
	if (!key) throw new Error("OPENROUTER_API_KEY is required for image analysis")
	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			signal,
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: process.env.VISION_MODEL ?? "google/gemini-2.5-flash",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "Describe this product or design image for a searchable knowledge base. Include visible text, hierarchy, controls, states, and relationships. Do not infer secrets.",
							},
							{
								type: "image_url",
								image_url: {
									url: `data:${mimeType};base64,${data.toString("base64")}`,
								},
							},
						],
					},
				],
			}),
		},
	)
	if (!response.ok)
		throw new Error(`Image analysis failed (${response.status})`)
	const payload = (await response.json()) as {
		choices?: { message?: { content?: string } }[]
	}
	const description = payload.choices?.[0]?.message?.content?.trim()
	if (!description) throw new Error("Image analysis returned no description")
	return description
}

async function transcribeAudio(
	data: Buffer,
	fileName: string,
	mimeType: string,
	signal?: AbortSignal,
) {
	const key = process.env.OPENAI_API_KEY
	if (!key) throw new Error("OPENAI_API_KEY is required for transcription")
	const body = new FormData()
	body.set("model", process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe")
	body.set("file", new File([data], fileName, { type: mimeType }))
	const response = await fetch(
		"https://api.openai.com/v1/audio/transcriptions",
		{
			signal,
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			body,
		},
	)
	if (!response.ok) throw new Error(`Transcription failed (${response.status})`)
	const payload = (await response.json()) as { text?: string }
	if (!payload.text?.trim()) throw new Error("Transcription returned no text")
	return payload.text.trim()
}

async function extractVideo(
	file: File,
	buffer: Buffer,
	signal?: AbortSignal,
): Promise<ExtractedDocument> {
	const extractor = process.env.MEDIA_EXTRACTOR_PATH
	if (!extractor)
		throw new Error("MEDIA_EXTRACTOR_PATH is required for video extraction")
	const directory = await mkdtemp(join(tmpdir(), "context-layer-video-"))
	try {
		const source = join(directory, `source${extname(file.name) || ".mp4"}`)
		const audio = join(directory, "audio.m4a")
		await writeFile(source, buffer)
		const process = Bun.spawn([extractor, source, directory], {
			signal,
			stdout: "pipe",
			stderr: "pipe",
		})
		if ((await process.exited) !== 0) {
			throw new Error(
				`Video extraction failed: ${await new Response(process.stderr).text()}`,
			)
		}
		const metadata = JSON.parse(await new Response(process.stdout).text()) as {
			durationSeconds?: number
			frameTimestamps?: number[]
		}
		const sections: string[] = []
		const locatedSections: NonNullable<ExtractedDocument["sections"]> = []
		try {
			const transcript = await transcribeAudio(
				await readFile(audio),
				"audio.m4a",
				"audio/mp4",
				signal,
			)
			sections.push(`Transcript\n${transcript}`)
			locatedSections.push({
				text: transcript,
				provenance: {
					mediaType: "video",
					startSeconds: 0,
					endSeconds: metadata.durationSeconds,
				},
			})
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("ENOENT"))
				throw error
		}
		const frames = (await readdir(directory))
			.filter((name) => name.startsWith("frame-") && name.endsWith(".jpg"))
			.sort()
		const derived: NonNullable<ExtractedDocument["derived"]> = []
		for (const [index, frame] of frames.entries()) {
			signal?.throwIfAborted()
			const data = await readFile(join(directory, frame))
			const timestampSeconds = metadata.frameTimestamps?.[index] ?? index * 30
			derived.push({
				kind: "media_keyframe",
				data,
				mimeType: "image/jpeg",
				metadata: { index, fileName: frame, timestampSeconds },
			})
			const description = await describeImage(data, "image/jpeg", signal)
			sections.push(`Scene ${index + 1}\n${description}`)
			locatedSections.push({
				text: description,
				provenance: { mediaType: "video", scene: index + 1, timestampSeconds },
			})
		}
		return {
			text: sections.join("\n\n"),
			provenance: {
				mediaType: "video",
				durationSeconds: metadata.durationSeconds,
				keyframeCount: frames.length,
			},
			sections: locatedSections,
			derived,
		}
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

export function extractionCategory(file: File) {
	const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
	if (IMAGE_EXTENSIONS.has(ext) || file.type.startsWith("image/"))
		return "image"
	if (AUDIO_EXTENSIONS.has(ext) || file.type.startsWith("audio/"))
		return "audio"
	if (VIDEO_EXTENSIONS.has(ext) || file.type.startsWith("video/"))
		return "video"
	return "document"
}

export async function extractDocument(
	file: File,
	signal?: AbortSignal,
): Promise<ExtractedDocument> {
	signal?.throwIfAborted()
	const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
	const buffer = Buffer.from(await file.arrayBuffer())
	if (ext === "pdf") {
		const pages: string[] = []
		const result = await pdfParse(buffer, {
			pagerender: async (page) => {
				const content = await page.getTextContent({
					normalizeWhitespace: false,
					disableCombineTextItems: false,
				})
				const text = content.items
					.map((item: { str?: string }) => item.str ?? "")
					.join(" ")
					.replace(/\s+/g, " ")
					.trim()
				pages.push(text)
				return text
			},
		})
		const sections = pages.map((text, index) => ({
			text,
			provenance: { format: "pdf", page: index + 1 },
		}))
		return {
			text: result.text,
			provenance: { format: "pdf", pageCount: result.numpages },
			sections,
		}
	}
	if (TEXT_EXTENSIONS.has(ext)) {
		const raw = buffer.toString("utf-8")
		const text =
			ext === "html" || ext === "htm"
				? textFromXml(xml.parse(raw)).join(" ")
				: raw
		return {
			text,
			provenance: { format: ext },
			sections: [{ text, provenance: { format: ext } }],
		}
	}
	if (ext === "docx") {
		const sections = await officeXmlText(buffer, ["word/document.xml"])
		const text = sections.join("\n\n")
		return {
			text,
			provenance: { format: "docx" },
			sections: [{ text, provenance: { format: "docx" } }],
		}
	}
	if (ext === "pptx") {
		const zip = await safeZip(buffer)
		const paths = Object.keys(zip.files)
			.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		const sections = await officeXmlText(buffer, paths)
		return {
			text: sections
				.map((section, index) => `Slide ${index + 1}\n${section}`)
				.join("\n\n"),
			provenance: { format: "pptx", slideCount: sections.length },
			sections: sections.map((text, index) => ({
				text,
				provenance: { format: "pptx", slide: index + 1 },
			})),
		}
	}
	if (ext === "xlsx") {
		const sections = await xlsxSections(buffer)
		return {
			text: sections.map(({ text }) => text).join("\n\n"),
			provenance: { format: "xlsx", sheetCount: sections.length },
			sections,
		}
	}
	if (IMAGE_EXTENSIONS.has(ext) || file.type.startsWith("image/")) {
		const text = await describeImage(
			buffer,
			file.type || `image/${ext}`,
			signal,
		)
		return {
			text,
			provenance: { mediaType: "image" },
			sections: [{ text, provenance: { mediaType: "image" } }],
		}
	}
	if (AUDIO_EXTENSIONS.has(ext) || file.type.startsWith("audio/")) {
		const text = await transcribeAudio(
			buffer,
			file.name,
			file.type || "application/octet-stream",
			signal,
		)
		return {
			text,
			provenance: { mediaType: "audio" },
			sections: [{ text, provenance: { mediaType: "audio" } }],
		}
	}
	if (VIDEO_EXTENSIONS.has(ext) || file.type.startsWith("video/")) {
		return extractVideo(file, buffer, signal)
	}
	throw new Error(
		`Unsupported file type: .${ext || "unknown"}. Supported: text, PDF, DOCX, PPTX, XLSX, images, audio, and video.`,
	)
}

export async function extractText(file: File) {
	return (await extractDocument(file)).text
}
