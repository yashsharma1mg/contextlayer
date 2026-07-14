import { expect, test } from "@playwright/test"

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8789"

test("a new team can create and discuss a canvas project", async ({ page }) => {
	test.setTimeout(60_000)
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const organizationName = `Canvas team ${suffix}`
	const projectName = `Checkout flow ${suffix}`

	await page.goto("/login")
	await page.getByRole("button", { name: "Need an account? Sign up" }).click()
	await page.getByPlaceholder("Name").fill("Canvas Tester")
	await page.getByPlaceholder("Email").fill(`canvas-${suffix}@example.test`)
	await page.getByPlaceholder("Password").fill("test-password-12345")
	await page.getByRole("button", { name: "Sign up" }).click()

	await page.getByPlaceholder("Organization name").fill(organizationName)
	await page.getByRole("button", { name: "Create" }).click()
	await expect(page.getByRole("link", { name: "Projects" })).toBeVisible()

	await page.getByRole("link", { name: "Projects" }).click()
	await page.getByPlaceholder("New project name").fill(projectName)
	await page.getByRole("button", { name: "Create" }).click()
	await page.getByRole("link", { name: projectName }).click()
	await page.waitForURL(/\/projects\/[^/]+$/)
	const projectId = new URL(page.url()).pathname.split("/").pop()
	if (!projectId) throw new Error("Project route did not contain an ID")

	await expect(page.getByText("Context Layer").first()).toBeVisible()
	const tokenResponse = await page.evaluate(async (url) => {
		const response = await fetch(url, {
			method: "POST",
			credentials: "include",
		})
		return { status: response.status, body: await response.json() }
	}, `${apiUrl}/api/projects/${projectId}/capture-tokens`)
	expect(tokenResponse.status).toBe(201)
	const { token } = tokenResponse.body as { token: string }
	const captureResponse = await page.request.post(
		`${apiUrl}/api/capture/import`,
		{
			headers: { Authorization: `Bearer ${token}` },
			data: {
				projectId,
				title: "Checkout confirmation",
				url: "https://example.test/checkout/confirm",
				domOutline: JSON.stringify({
					root: {
						tag: "main",
						label: "Checkout",
						children: [{ tag: "h1", text: "Confirm order" }],
					},
				}),
				screenshot:
					"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				metadata: {
					flowSessionId: `flow-${suffix}`,
					flowStep: 0,
					viewport: { width: 1440, height: 900 },
				},
			},
		},
	)
	expect(captureResponse.status()).toBe(201)
	const imported = (await captureResponse.json()) as {
		capture: { id: string }
		job: { id: string }
	}
	await expect
		.poll(
			() =>
				page.evaluate(async (url) => {
					const response = await fetch(url, { credentials: "include" })
					const payload = (await response.json()) as {
						job?: { status: string }
					}
					return payload.job?.status ?? `http:${response.status}`
				}, `${apiUrl}/api/jobs/${imported.job.id}`),
			{ timeout: 20_000 },
		)
		.toBe("succeeded")
	const search = (await page.evaluate(
		async (url) => {
			const response = await fetch(url, { credentials: "include" })
			return response.json()
		},
		`${apiUrl}/api/memories/search?q=${encodeURIComponent("Confirm order")}`,
	)) as {
		results: { source: string; title: string }[]
	}
	expect(search.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				source: "capture",
				title: "Checkout confirmation",
			}),
		]),
	)
	const screenshotResponse = await page.evaluate(async (url) => {
		const response = await fetch(url, { credentials: "include" })
		return {
			status: response.status,
			contentType: response.headers.get("content-type"),
		}
	}, `${apiUrl}/api/captures/${imported.capture.id}/screenshot`)
	expect(screenshotResponse.status).toBe(200)
	expect(screenshotResponse.contentType).toBe("image/png")
	await page.reload()
	await expect(page.getByText("Checkout confirmation")).toBeVisible()
	await page.getByRole("button", { name: "Add note" }).click()
	await expect(page.getByText("Untitled note")).toBeVisible()
	await page.getByRole("button", { name: "Fit View" }).click()

	await page.getByText("Untitled note").click()
	await page.getByRole("button", { name: "Comments" }).click()
	await page.getByPlaceholder("Leave a review note").fill("Ready for review")
	await page.getByRole("button", { name: "Comment", exact: true }).click()
	await expect(page.getByText("Ready for review")).toBeVisible()
	await page.getByText("Untitled note", { exact: true }).click()
	await page.keyboard.press("Delete")
	await expect(page.getByText("Untitled note", { exact: true })).toHaveCount(0)
	await page.getByRole("button", { name: "Canvas history" }).click()
	page.once("dialog", (dialog) => dialog.accept())
	await page
		.getByRole("button", { name: "Restore", exact: true })
		.first()
		.click()
	await expect(page.getByText("Untitled note", { exact: true })).toBeVisible()
	await page.getByRole("button", { name: "Fit View" }).click()
	await page.getByText("Untitled note", { exact: true }).click()
	await page.getByRole("button", { name: "Comments" }).click()
	await expect(page.getByText("Ready for review")).toBeVisible()

	await page.getByRole("button", { name: "Share", exact: true }).click()
	await page.getByRole("button", { name: "Create read-only link" }).click()
	const shareUrl = await page.getByLabel("Read-only share link").inputValue()
	const viewer = await page.context().browser()?.newContext()
	if (!viewer) throw new Error("Could not create an anonymous browser context")
	const viewerPage = await viewer.newPage()
	await viewerPage.goto(shareUrl)
	await expect(viewerPage.getByText("Read only")).toBeVisible()
	await expect(
		viewerPage.getByRole("button", { name: "Add note" }),
	).toHaveCount(0)

	await page.getByRole("button", { name: "Revoke", exact: true }).click()
	await viewerPage.reload()
	await expect(
		viewerPage.getByText("Share link is invalid or expired"),
	).toBeVisible()
	await viewer.close()
})
