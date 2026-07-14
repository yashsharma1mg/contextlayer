"use client"

import { use } from "react"
import { CanvasWorkspace } from "@/components/canvas-workspace"

export default function SharedCanvasPage({
	params,
}: {
	params: Promise<{ token: string }>
}) {
	const { token } = use(params)
	return <CanvasWorkspace shareToken={token} />
}
