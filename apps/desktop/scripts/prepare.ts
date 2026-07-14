import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { preparePostgresBundle } from "./postgres-bundle"

const desktop = resolve(import.meta.dir, "..")
const root = resolve(desktop, "../..")
const target = "aarch64-apple-darwin"
const binaries = join(desktop, "src-tauri", "binaries")
const resources = join(desktop, "src-tauri", "resources")

async function run(
	command: string[],
	cwd = root,
	env?: Record<string, string>,
) {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	})
	if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`)
}

async function exists(path: string) {
	return stat(path).then(
		() => true,
		() => false,
	)
}

await mkdir(binaries, { recursive: true })
await mkdir(resources, { recursive: true })
await rm(join(resources, "studio"), { force: true, recursive: true })
await rm(join(resources, "migrations"), { force: true, recursive: true })
const standalone = join(root, "apps", "studio", ".next", "standalone")
if (!(await exists(standalone))) {
	await run(["bun", "run", "build"], join(root, "apps", "studio"), {
		NEXT_PUBLIC_API_URL: "http://127.0.0.1:31421",
	})
}
await run([
	"/usr/bin/ditto",
	"--noqtn",
	join(root, "apps", "studio", ".next", "static"),
	join(standalone, "apps", "studio", ".next", "static"),
])
await run(["/usr/bin/ditto", "--noqtn", standalone, join(resources, "studio")])
await cp(
	join(root, "packages", "db", "migrations"),
	join(resources, "migrations"),
	{
		recursive: true,
	},
)
await run([
	"bun",
	"build",
	join(root, "apps", "context-agent", "src", "index.ts"),
	"--compile",
	"--target=bun-darwin-arm64",
	`--outfile=${join(binaries, `context-agent-${target}`)}`,
])
await run([
	"bun",
	"build",
	join(desktop, "scripts", "prototype-compiler.ts"),
	"--compile",
	"--target=bun-darwin-arm64",
	`--outfile=${join(binaries, `prototype-compiler-${target}`)}`,
])
await run([
	"/usr/bin/ditto",
	"--noqtn",
	process.execPath,
	join(binaries, `studio-${target}`),
])
await run([
	"xcrun",
	"swiftc",
	"-O",
	"-parse-as-library",
	"-target",
	"arm64-apple-macos13.0",
	"-framework",
	"AVFoundation",
	"-framework",
	"AppKit",
	join(desktop, "scripts", "media-extractor.swift"),
	"-o",
	join(binaries, `media-extractor-${target}`),
])

await preparePostgresBundle(join(resources, "postgres"))

const required = [
	"context-agent",
	"studio",
	"prototype-compiler",
	"media-extractor",
]
const prepared = new Set(await readdir(binaries))
for (const name of required) {
	if (!prepared.has(`${name}-${target}`))
		throw new Error(`Missing ${name} sidecar`)
}
