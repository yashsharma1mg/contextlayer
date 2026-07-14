import { expect, test } from "@playwright/test"

test("a new team can create and discuss a canvas project", async ({ page }) => {
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

	await expect(page.getByText("Context Layer").first()).toBeVisible()
	await page.getByRole("button", { name: "Add note" }).click()
	await expect(page.getByText("Untitled note")).toBeVisible()

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
