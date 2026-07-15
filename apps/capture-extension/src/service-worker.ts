export {}

type Settings = { apiUrl?: string; projectId?: string; captureToken?: string }

type Redaction = {
	x: number
	y: number
	width: number
	height: number
	label: string
	locked: boolean
}

function captureOutline() {
	const maxNodes = 350
	let seen = 0
	const redactions: Redaction[] = []
	const isVisible = (element: Element) => {
		const style = getComputedStyle(element)
		const rect = element.getBoundingClientRect()
		return (
			style.display !== "none" &&
			style.visibility !== "hidden" &&
			rect.right > 0 &&
			rect.bottom > 0 &&
			rect.left < innerWidth &&
			rect.top < innerHeight &&
			rect.width > 0 &&
			rect.height > 0
		)
	}
	const ownText = (element: Element) =>
		Array.from(element.childNodes)
			.filter((child) => child.nodeType === Node.TEXT_NODE)
			.map((child) => child.textContent || "")
			.join(" ")
			.trim()
			.slice(0, 180) || undefined
	const walk = (
		element: Element,
		depth = 0,
	): Record<string, unknown> | null => {
		if (seen >= maxNodes || depth > 8 || !isVisible(element)) return null
		seen += 1
		const html = element as HTMLElement
		const style = getComputedStyle(element)
		const tag = element.tagName.toLowerCase()
		if (["script", "style", "noscript", "template"].includes(tag)) return null
		const sensitive =
			tag === "input" ||
			tag === "textarea" ||
			tag === "select" ||
			element.getAttribute("contenteditable") === "true"
		if (sensitive) {
			const rect = element.getBoundingClientRect()
			const left = Math.max(0, rect.left)
			const top = Math.max(0, rect.top)
			redactions.push({
				x: left,
				y: top,
				width: Math.max(0, Math.min(innerWidth, rect.right) - left),
				height: Math.max(0, Math.min(innerHeight, rect.bottom) - top),
				label: element.getAttribute("aria-label") || tag,
				locked: true,
			})
		}
		const node: Record<string, unknown> = {
			tag,
			role: element.getAttribute("role") || undefined,
			label: element.getAttribute("aria-label") || undefined,
			text: sensitive ? undefined : ownText(element),
			redacted: sensitive || undefined,
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
	return {
		domOutline: JSON.stringify({
			root: walk(document.body),
			title: document.title,
			capturedAt: new Date().toISOString(),
		}),
		redactions,
	}
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
		const [{ result: capture }] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: captureOutline,
		})
		if (!capture) throw new Error("The page could not be inspected")
		const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
			format: "png",
		})
		const previousKey = `previousCapture:${config.projectId}`
		const sessionKey = `flowSession:${config.projectId}`
		const stepKey = `flowStep:${config.projectId}`
		const saved = await chrome.storage.local.get([
			previousKey,
			sessionKey,
			stepKey,
		])
		const flowSessionId =
			typeof saved[sessionKey] === "string"
				? saved[sessionKey]
				: crypto.randomUUID()
		const flowStep = typeof saved[stepKey] === "number" ? saved[stepKey] : 0
		if (!saved[sessionKey]) {
			await chrome.storage.local.set({
				[sessionKey]: flowSessionId,
				[stepKey]: flowStep,
			})
		}
		await chrome.storage.session.set({
			pendingCapture: {
				apiUrl: config.apiUrl,
				projectId: config.projectId,
				captureToken: config.captureToken,
				title: tab.title || new URL(tab.url).hostname,
				url: tab.url,
				domOutline: capture.domOutline,
				screenshot,
				redactions: capture.redactions,
				viewport: { width: tab.width, height: tab.height },
				previousCaptureId: saved[previousKey],
				flowSessionId,
				flowStep,
			},
		})
		await chrome.tabs.create({ url: chrome.runtime.getURL("preview.html") })
		await setBadge("…", "#2563eb")
	} catch (error) {
		console.error("Context Layer capture failed", error)
		await setBadge("!", "#dc2626")
	}
})
