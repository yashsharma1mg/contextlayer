import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { postgresBundleManifest } from "./postgres-bundle"

test("pins an arm64-compatible PostgreSQL 17 bundle by checksum", () => {
	expect(postgresBundleManifest.majorVersion).toBe(17)
	expect(postgresBundleManifest.imageSha256).toMatch(/^[a-f0-9]{64}$/)
	expect(postgresBundleManifest.binaries).toContain("pg_restore")
})

test("compiles a browser entry in the short-lived prototype worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "context-layer-worker-test-"))
	try {
		const entry = join(directory, "entry.ts")
		await Bun.write(
			entry,
			'document.getElementById("root")!.textContent = "worker-passed"',
		)
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "prototype-compiler.ts")],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		)
		child.stdin.write(
			JSON.stringify({ entry, outdir: join(directory, "dist") }),
		)
		child.stdin.end()
		const [exitCode, output] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
		])
		expect(exitCode).toBe(0)
		const result = JSON.parse(output) as {
			success: boolean
			outputs: { content: string }[]
		}
		expect(result.success).toBe(true)
		expect(
			result.outputs.some((item) => item.content.includes("worker-passed")),
		).toBe(true)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
