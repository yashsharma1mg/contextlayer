import { defineConfig, devices } from "@playwright/test"

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8789"
const studioUrl = process.env.PLAYWRIGHT_STUDIO_URL ?? "http://localhost:3002"

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: {
		baseURL: studioUrl,
		trace: "on-first-retry",
		...devices["Desktop Chrome"],
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
		},
	},
	webServer: [
		{
			command: `cd ../context-agent && PORT=8789 STUDIO_URL=${studioUrl} bun run dev`,
			url: `${apiUrl}/health`,
			reuseExistingServer: !process.env.CI,
		},
		{
			command: `NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_URL=${apiUrl} bun run dev -- -p 3002`,
			url: `${studioUrl}/login`,
			reuseExistingServer: !process.env.CI,
		},
	],
})
