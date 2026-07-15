import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const release = "2.9.5"
const imageName = `Postgres-${release}-17.dmg`
const imageUrl = `https://github.com/PostgresApp/PostgresApp/releases/download/v${release}/${imageName}`
const imageSha256 =
	"9189567e943edfa2441c4bc72751bcfb9b417fb3f7cc32d2252991e92b22d2d0"
const binaries = [
	"postgres",
	"initdb",
	"createdb",
	"psql",
	"pg_isready",
	"pg_dump",
	"pg_restore",
]

export const postgresBundleManifest = {
	release,
	majorVersion: 17,
	imageName,
	imageUrl,
	imageSha256,
	binaries,
} as const

async function exists(path: string) {
	return stat(path).then(
		() => true,
		() => false,
	)
}

async function output(command: string[]) {
	const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	])
	if (exitCode !== 0) throw new Error(stderr || `${command.join(" ")} failed`)
	return stdout.trim()
}

async function run(command: string[]) {
	await output(command)
}

async function downloadImage(path: string) {
	if (!(await exists(path))) {
		const temporary = `${path}.download`
		await rm(temporary, { force: true })
		await run([
			"/usr/bin/curl",
			"--fail",
			"--location",
			"--retry",
			"3",
			"--output",
			temporary,
			imageUrl,
		])
		await rename(temporary, path)
	}
	const digest = (await output(["/usr/bin/shasum", "-a", "256", path])).split(
		/\s+/,
	)[0]
	if (digest !== imageSha256) {
		await rm(path, { force: true })
		throw new Error("PostgreSQL bundle checksum mismatch")
	}
}

async function thinArm64(path: string) {
	const info = await output(["/usr/bin/lipo", "-info", path]).catch(() => "")
	if (!info.includes("Architectures in the fat file")) return
	const temporary = `${path}.arm64`
	await run(["/usr/bin/lipo", path, "-thin", "arm64", "-output", temporary])
	await rename(temporary, path)
}

async function copyLibraries(
	source: string,
	destination: string,
	roots: string[],
) {
	const pending = [...roots]
	const copied = new Set<string>()
	while (pending.length) {
		const file = pending.pop()
		if (!file || copied.has(file)) continue
		copied.add(file)
		const dependencies = await output(["/usr/bin/otool", "-L", file]).catch(
			() => "",
		)
		for (const line of dependencies.split("\n").slice(1)) {
			const dependency = line.trim().split(/\s+/)[0]
			if (
				!dependency?.startsWith("@loader_path") &&
				!dependency?.startsWith(join(source, "lib"))
			)
				continue
			const name = basename(dependency)
			const candidate = join(source, "lib", name)
			if (!(await exists(candidate)) || copied.has(candidate)) continue
			await cp(candidate, join(destination, "lib", name), { dereference: true })
			await thinArm64(join(destination, "lib", name))
			pending.push(candidate)
		}
	}
}

async function copyPostgres(source: string, destination: string) {
	await rm(destination, { force: true, recursive: true })
	await mkdir(join(destination, "bin"), { recursive: true })
	await mkdir(join(destination, "lib", "postgresql"), { recursive: true })
	await mkdir(join(destination, "share", "postgresql", "extension"), {
		recursive: true,
	})

	const copiedBinaries: string[] = []
	for (const name of binaries) {
		const target = join(destination, "bin", name)
		await cp(join(source, "bin", name), target)
		await thinArm64(target)
		copiedBinaries.push(join(source, "bin", name))
	}

	for (const name of ["vector.dylib", "plpgsql.dylib", "dict_snowball.dylib"]) {
		const target = join(destination, "lib", "postgresql", name)
		await cp(join(source, "lib", "postgresql", name), target)
		await thinArm64(target)
	}
	await copyLibraries(source, destination, [
		...copiedBinaries,
		join(source, "lib", "postgresql", "vector.dylib"),
		join(source, "lib", "postgresql", "dict_snowball.dylib"),
	])

	const shareSource = join(source, "share", "postgresql")
	for (const entry of await readdir(shareSource, { withFileTypes: true })) {
		if (entry.isFile())
			await cp(
				join(shareSource, entry.name),
				join(destination, "share", "postgresql", entry.name),
			)
	}
	for (const directory of ["timezone", "timezonesets", "tsearch_data"]) {
		await cp(
			join(shareSource, directory),
			join(destination, "share", "postgresql", directory),
			{
				recursive: true,
			},
		)
	}
	for (const entry of await readdir(join(shareSource, "extension"))) {
		if (!/^(vector|plpgsql)(--.*)?\.(control|sql)$/.test(entry)) continue
		await cp(
			join(shareSource, "extension", entry),
			join(destination, "share", "postgresql", "extension", entry),
		)
	}
}

export async function preparePostgresBundle(destination: string) {
	if (process.env.POSTGRES_BUNDLE_DIR) {
		await copyPostgres(process.env.POSTGRES_BUNDLE_DIR, destination)
		return
	}
	const cache = join(homedir(), "Library", "Caches", "Context Layer", "build")
	const image = join(cache, imageName)
	const mount = join(cache, "postgres-volume")
	await mkdir(cache, { recursive: true })
	await downloadImage(image)
	await rm(mount, { force: true, recursive: true })
	await mkdir(mount, { recursive: true })
	await run([
		"/usr/bin/hdiutil",
		"attach",
		"-nobrowse",
		"-readonly",
		"-mountpoint",
		mount,
		image,
	])
	try {
		await copyPostgres(
			join(mount, "Postgres.app", "Contents", "Versions", "17"),
			destination,
		)
	} finally {
		await run(["/usr/bin/hdiutil", "detach", mount])
	}
}
