type Settings = { apiUrl?: string; projectId?: string; captureToken?: string }

function captureOutline() {
	const maxNodes = 350
	let seen = 0
	const isVisible = (element: Element) => {
		const style = getComputedStyle(element)
		const rect = element.getBoundingClientRect()
		return (
			style.display !== "none" &&
			style.visibility !== "hidden" &&
			rect.width > 0 &&
			rect.height > 0
		)
	}
	const walk = (
		element: Element,
		depth = 0,
	): Record<string, unknown> | null => {
		if (seen >= maxNodes || depth > 8 || !isVisible(element)) return null
		seen += 1
		const html = element as HTMLElement
		const style = getComputedStyle(element)
		const tag = element.tagName.toLowerCase()
		const sensitive = tag === "input" || tag === "textarea" || tag === "select"
		const node: Record<string, unknown> = {
			tag,
			role: element.getAttribute("role") || undefined,
			label: element.getAttribute("aria-label") || undefined,
			text: sensitive
				? undefined
				: (html.innerText || "").trim().slice(0, 180) || undefined,
			interactive:
				["a", "button", "input", "select", "textarea"].includes(tag) ||
				html.tabIndex >= 0,
			style: {
				display: style.display,
				position: style.position,
				color: style.color,
				backgroundColor: style.backgroundColor,
				fontSize: style.fontSize,
				fontWeight: style.fontWeight,
				borderRadius: style.borderRadius,
			},
		}
		const children = Array.from(element.children)
			.map((child) => walk(child, depth + 1))
			.filter(Boolean)
		if (children.length) node.children = children
		return node
	}
	return JSON.stringify({
		root: walk(document.body),
		title: document.title,
		capturedAt: new Date().toISOString(),
	})
}

async function settings(): Promise<Settings> {
	return chrome.storage.local.get(["apiUrl", "projectId", "captureToken"])
}

async function setBadge(text: string, color: string) {
	await chrome.action.setBadgeText({ text })
	await chrome.action.setBadgeBackgroundColor({ color })
}

chrome.action.onClicked.addListener(async (tab) => {
	try {
		if (!tab.id || !tab.url || !tab.windowId)
			throw new Error("Open a normal browser tab before capturing")
		const config = await settings()
		if (!config.apiUrl || !config.projectId || !config.captureToken) {
			await chrome.runtime.openOptionsPage()
			return
		}
		const [{ result: domOutline }] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: captureOutline,
		})
		const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
			format: "png",
		})
		const previousKey = `previousCapture:${config.projectId}`
		const saved = await chrome.storage.local.get(previousKey)
		const response = await fetch(`${config.apiUrl}/api/capture/import`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.captureToken}`,
			},
			body: JSON.stringify({
				projectId: config.projectId,
				title: tab.title || new URL(tab.url).hostname,
				url: tab.url,
				domOutline,
				screenshot,
				metadata: {
					viewport: { width: tab.width, height: tab.height },
					extension: "capture-extension",
				},
				previousCaptureId: saved[previousKey],
			}),
		})
		if (!response.ok) throw new Error(`Capture failed (${response.status})`)
		const payload = (await response.json()) as { capture: { id: string } }
		await chrome.storage.local.set({ [previousKey]: payload.capture.id })
		await setBadge("OK", "#16a34a")
		setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2_000)
	} catch (error) {
		console.error("Context Layer capture failed", error)
		await setBadge("!", "#dc2626")
	}
})
