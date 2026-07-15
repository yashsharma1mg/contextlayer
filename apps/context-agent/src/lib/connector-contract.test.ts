import { expect, test } from "bun:test"
import { JobExecutionError } from "./background-jobs"
import { responseJson } from "./connector-sync"
import { isPrivateAddress } from "./safe-fetch"

test("classifies connector rate limits for durable retry", async () => {
	const error = await responseJson(
		new Response("slow down", {
			status: 429,
			headers: { "Retry-After": "45" },
		}),
	).catch((cause) => cause)

	expect(error).toBeInstanceOf(JobExecutionError)
	if (!(error instanceof JobExecutionError))
		throw new Error("Expected job error")
	expect(error.options).toEqual({ retryable: true, retryAfterSeconds: 45 })
})

test("treats revoked connector credentials as terminal", async () => {
	const error = await responseJson(
		new Response("revoked", { status: 401 }),
	).catch((cause) => cause)
	if (!(error instanceof JobExecutionError))
		throw new Error("Expected job error")
	expect(error.options.retryable).toBe(false)
})

test("blocks private and IPv4-mapped private network destinations", () => {
	for (const address of [
		"127.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"198.18.0.1",
		"::1",
		"::ffff:172.16.0.1",
	]) {
		expect(isPrivateAddress(address)).toBe(true)
	}
	expect(isPrivateAddress("8.8.8.8")).toBe(false)
	expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false)
})
