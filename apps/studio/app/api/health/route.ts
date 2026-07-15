export function GET() {
	const memory = process.memoryUsage()
	return Response.json({
		ok: true,
		sidecar: "studio",
		resources: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
	})
}
