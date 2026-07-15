type Redaction = {
	x: number
	y: number
	width: number
	height: number
	label: string
	locked?: boolean
}
type PendingCapture = {
	apiUrl: string
	projectId: string
	captureToken: string
	title: string
	url: string
	domOutline: string
	screenshot: string
	redactions: Redaction[]
	viewport: { width?: number; height?: number }
	previousCaptureId?: string
	flowSessionId: string
	flowStep: number
}

function required<T extends Element>(selector: string): T {
	const element = document.querySelector<T>(selector)
	if (!element) throw new Error(`Missing preview element ${selector}`)
	return element
}

const canvas = required<HTMLCanvasElement>("#preview")
const context = canvas.getContext("2d")
if (!context) throw new Error("Canvas is unavailable")
const drawingContext = context
const statusElement = required<HTMLElement>("#status")
const upload = required<HTMLButtonElement>("#upload")
const list = required<HTMLElement>("#redactions")
let pending: PendingCapture
let image: HTMLImageElement
let redactions: Redaction[] = []
let start: { x: number; y: number } | null = null

function scales() {
	return {
		x: canvas.width / Math.max(1, pending.viewport.width ?? canvas.width),
		y: canvas.height / Math.max(1, pending.viewport.height ?? canvas.height),
	}
}

function draw() {
	drawingContext.drawImage(image, 0, 0)
	const scale = scales()
	drawingContext.fillStyle = "#111827"
	for (const redaction of redactions) {
		drawingContext.fillRect(
			redaction.x * scale.x,
			redaction.y * scale.y,
			redaction.width * scale.x,
			redaction.height * scale.y,
		)
	}
	list.replaceChildren(
		...redactions.map((redaction, index) => {
			const row = document.createElement("div")
			row.className = "redaction"
			const label = document.createElement("span")
			label.textContent = redaction.label
			if (redaction.locked) {
				label.textContent = `${redaction.label} (protected)`
				row.append(label)
			} else {
				const remove = document.createElement("button")
				remove.type = "button"
				remove.textContent = "×"
				remove.title = `Remove ${redaction.label} redaction`
				remove.addEventListener("click", () => {
					redactions.splice(index, 1)
					draw()
				})
				row.append(label, remove)
			}
			return row
		}),
	)
}

function point(event: PointerEvent) {
	const rect = canvas.getBoundingClientRect()
	const scale = scales()
	return {
		x: ((event.clientX - rect.left) * (canvas.width / rect.width)) / scale.x,
		y: ((event.clientY - rect.top) * (canvas.height / rect.height)) / scale.y,
	}
}

canvas.addEventListener("pointerdown", (event) => {
	start = point(event)
	canvas.setPointerCapture(event.pointerId)
})

canvas.addEventListener("pointerup", (event) => {
	if (!start) return
	const end = point(event)
	const redaction = {
		x: Math.min(start.x, end.x),
		y: Math.min(start.y, end.y),
		width: Math.abs(end.x - start.x),
		height: Math.abs(end.y - start.y),
		label: "Manual area",
		locked: false,
	}
	start = null
	if (redaction.width >= 4 && redaction.height >= 4) redactions.push(redaction)
	draw()
})

required<HTMLButtonElement>("#cancel").addEventListener("click", async () => {
	await chrome.storage.session.remove("pendingCapture")
	window.close()
})

upload.addEventListener("click", async () => {
	upload.disabled = true
	statusElement.textContent = ""
	try {
		draw()
		const response = await fetch(`${pending.apiUrl}/api/capture/import`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${pending.captureToken}`,
			},
			body: JSON.stringify({
				projectId: pending.projectId,
				title: pending.title,
				url: pending.url,
				domOutline: pending.domOutline,
				screenshot: canvas.toDataURL("image/png"),
				metadata: {
					viewport: pending.viewport,
					extension: "capture-extension",
					redactionCount: redactions.length,
					flowSessionId: pending.flowSessionId,
					flowStep: pending.flowStep,
				},
				previousCaptureId: pending.previousCaptureId,
			}),
		})
		if (!response.ok) throw new Error(`Capture failed (${response.status})`)
		const result = (await response.json()) as { capture: { id: string } }
		await chrome.storage.local.set({
			[`previousCapture:${pending.projectId}`]: result.capture.id,
			[`flowSession:${pending.projectId}`]: pending.flowSessionId,
			[`flowStep:${pending.projectId}`]: pending.flowStep + 1,
		})
		await chrome.storage.session.remove("pendingCapture")
		await chrome.action.setBadgeText({ text: "OK" })
		await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" })
		window.close()
	} catch (error) {
		statusElement.textContent =
			error instanceof Error ? error.message : "Capture failed"
		upload.disabled = false
	}
})

async function initialize() {
	const saved = await chrome.storage.session.get("pendingCapture")
	if (!saved.pendingCapture) throw new Error("No capture is waiting for review")
	pending = saved.pendingCapture as PendingCapture
	redactions = [...pending.redactions]
	image = new Image()
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve()
		image.onerror = () => reject(new Error("Screenshot could not be loaded"))
		image.src = pending.screenshot
	})
	canvas.width = image.naturalWidth
	canvas.height = image.naturalHeight
	draw()
}

initialize().catch((error) => {
	statusElement.textContent =
		error instanceof Error ? error.message : "Preview failed"
	upload.disabled = true
})
export {}
