import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const app =
	process.argv[2] ??
	resolve(
		import.meta.dir,
		"../src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Context Layer.app/Contents/MacOS/context-layer-desktop",
	)
const data = await mkdtemp(join(tmpdir(), "context-layer-resource-gate-"))
const child = Bun.spawn([app], {
	env: { ...process.env, CONTEXT_LAYER_DATA_DIR: data },
	stdout: "ignore",
	stderr: "inherit",
})

const sleep = (ms: number) => Bun.sleep(ms)

async function waitForHealth() {
	const deadline = Date.now() + 90_000
	while (Date.now() < deadline) {
		try {
			if ((await fetch("http://127.0.0.1:31421/health")).ok) return
		} catch {}
		await sleep(500)
	}
	throw new Error("Desktop runtime did not become healthy")
}

type ProcessRow = {
	pid: number
	ppid: number
	rssKb: number
	cpu: number
	command: string
}

function processes() {
	const output = Bun.spawnSync([
		"/bin/ps",
		"-axo",
		"pid=,ppid=,rss=,%cpu=,command=",
	])
	if (output.exitCode !== 0) throw new Error("Could not inspect processes")
	return output.stdout
		.toString()
		.trim()
		.split("\n")
		.map((line): ProcessRow | null => {
			const match = line
				.trim()
				.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)
			return match
				? {
						pid: Number(match[1]),
						ppid: Number(match[2]),
						rssKb: Number(match[3]),
						cpu: Number(match[4]),
						command: match[5] ?? "",
					}
				: null
		})
		.filter((row): row is ProcessRow => !!row)
}

function processTree(rootPid: number) {
	const rows = processes()
	const ids = new Set([rootPid])
	for (let changed = true; changed; ) {
		changed = false
		for (const row of rows) {
			if (ids.has(row.ppid) && !ids.has(row.pid)) {
				ids.add(row.pid)
				changed = true
			}
		}
	}
	return rows.filter((row) => ids.has(row.pid))
}

let ownedPids: number[] = []
let stopped = false
async function stop() {
	if (stopped) return []
	stopped = true
	ownedPids = processTree(child.pid).map((row) => row.pid)
	Bun.spawnSync([
		"/usr/bin/osascript",
		"-e",
		'tell application id "design.contextlayer.desktop" to quit',
	])
	const quitDeadline = Date.now() + 15_000
	while (Date.now() < quitDeadline) {
		const live = new Set(processes().map((row) => row.pid))
		if (ownedPids.every((pid) => !live.has(pid))) return []
		await sleep(250)
	}
	let live = new Set(processes().map((row) => row.pid))
	for (const pid of ownedPids.filter((pid) => live.has(pid))) {
		Bun.spawnSync(["/bin/kill", "-TERM", String(pid)])
	}
	await sleep(2_000)
	live = new Set(processes().map((row) => row.pid))
	const survivors = ownedPids.filter((pid) => live.has(pid))
	for (const pid of survivors)
		Bun.spawnSync(["/bin/kill", "-KILL", String(pid)])
	return survivors
}

try {
	await waitForHealth()
	await sleep(Number(process.env.RESOURCE_SETTLE_MS ?? 45_000))
	const samples = []
	let breakdown: ProcessRow[] = []
	for (let index = 0; index < 5; index += 1) {
		const tree = processTree(child.pid)
		breakdown = tree
		samples.push({
			cpu: tree.reduce((total, row) => total + row.cpu, 0),
			rssMb: tree.reduce((total, row) => total + row.rssKb, 0) / 1024,
			processes: tree.length,
		})
		await sleep(1_000)
	}
	const cpu =
		samples.reduce((total, sample) => total + sample.cpu, 0) / samples.length
	const rssMb = Math.max(...samples.map((sample) => sample.rssMb))
	const survivors = await stop()
	if (survivors.length)
		throw new Error(`Desktop left processes running: ${survivors.join(", ")}`)
	if (cpu >= 2) throw new Error(`Settled CPU ${cpu.toFixed(1)}% exceeds 2%`)
	if (rssMb >= 750)
		throw new Error(`Idle memory ${rssMb.toFixed(1)} MB exceeds 750 MB`)
	console.log(
		JSON.stringify(
			{
				cpuPercent: cpu,
				rssMb,
				samples,
				processes: breakdown.map((row) => ({
					pid: row.pid,
					cpu: row.cpu,
					rssMb: row.rssKb / 1024,
					command: row.command,
				})),
			},
			null,
			2,
		),
	)
} finally {
	await stop()
	await rm(data, { recursive: true, force: true })
}
