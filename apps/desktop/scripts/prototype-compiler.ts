type Request = { entry: string; outdir: string }

try {
	const input = JSON.parse(await Bun.stdin.text()) as Request
	const result = await Bun.build({
		entrypoints: [input.entry],
		outdir: input.outdir,
		target: "browser",
		format: "iife",
		minify: true,
		sourcemap: "none",
	})
	const outputs = await Promise.all(
		result.outputs.map(async (output) => ({
			path: output.path,
			content: await output.text(),
		})),
	)
	if (
		outputs.reduce(
			(size, output) => size + Buffer.byteLength(output.content),
			0,
		) >
		5 * 1024 * 1024
	) {
		throw new Error("Compiled prototype exceeds the 5 MB output limit")
	}
	process.stdout.write(
		JSON.stringify({
			success: result.success,
			logs: result.logs.map((log) => log.message),
			outputs,
		}),
	)
} catch (error) {
	process.stderr.write(error instanceof Error ? error.message : String(error))
	process.exit(1)
}
