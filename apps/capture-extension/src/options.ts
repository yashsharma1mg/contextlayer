function requiredElement<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector)
	if (!element) throw new Error(`Missing extension option: ${selector}`)
	return element
}

const fields = {
	apiUrl: requiredElement<HTMLInputElement>("#apiUrl"),
	projectId: requiredElement<HTMLInputElement>("#projectId"),
	captureToken: requiredElement<HTMLInputElement>("#captureToken"),
	resetFlow: requiredElement<HTMLButtonElement>("#resetFlow"),
	status: requiredElement<HTMLElement>("#status"),
}

async function load() {
	const saved = await chrome.storage.local.get([
		"apiUrl",
		"projectId",
		"captureToken",
	])
	fields.apiUrl.value =
		typeof saved.apiUrl === "string" ? saved.apiUrl : "http://localhost:8787"
	fields.projectId.value =
		typeof saved.projectId === "string" ? saved.projectId : ""
	fields.captureToken.value =
		typeof saved.captureToken === "string" ? saved.captureToken : ""
}

requiredElement<HTMLButtonElement>("#save").addEventListener(
	"click",
	async () => {
		try {
			const url = new URL(fields.apiUrl.value)
			const granted = await chrome.permissions.request({
				origins: [`${url.origin}/*`],
			})
			if (!granted)
				throw new Error("Permission to reach the Context Agent was not granted")
			await chrome.storage.local.set({
				apiUrl: url.origin,
				projectId: fields.projectId.value.trim(),
				captureToken: fields.captureToken.value.trim(),
			})
			fields.status.textContent = "Capture target saved."
		} catch (error) {
			fields.status.textContent =
				error instanceof Error ? error.message : "Could not save capture target"
		}
	},
)

fields.resetFlow.addEventListener("click", async () => {
	const projectId = fields.projectId.value.trim()
	if (!projectId) {
		fields.status.textContent = "Enter a project ID before starting a new flow."
		return
	}
	await chrome.storage.local.remove(`previousCapture:${projectId}`)
	fields.status.textContent = "The next capture starts a new flow."
})

load().catch(() => undefined)
