import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const bundle = join(
	root,
	"src-tauri/target/aarch64-apple-darwin/release/bundle",
)
const app = join(bundle, "macos/Context Layer.app")
const output = join(bundle, "dmg/Context Layer_0.1.0_aarch64.dmg")
const stage = await mkdtemp(join(tmpdir(), "context-layer-dmg-"))

try {
	const signature = Bun.spawnSync([
		"codesign",
		"--verify",
		"--deep",
		"--strict",
		app,
	])
	if (signature.exitCode !== 0) {
		await Bun.$`codesign --force --deep --sign - ${app}`.quiet()
	}
	await Bun.$`/usr/bin/ditto --noqtn ${app} ${join(stage, "Context Layer.app")}`.quiet()
	await symlink("/Applications", join(stage, "Applications"))
	await Bun.$`mkdir -p ${join(bundle, "dmg")}`.quiet()
	await Bun.$`hdiutil create -ov -volname ${"Context Layer"} -srcfolder ${stage} -format UDZO ${output}`
	console.log(`Created ${output}`)
} finally {
	await rm(stage, { recursive: true, force: true })
}
