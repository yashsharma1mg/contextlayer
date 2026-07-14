"use client"

import { use } from "react"
import { CanvasWorkspace } from "@/components/canvas-workspace"

export default function ProjectPage({
	params,
}: {
	params: Promise<{ id: string }>
}) {
	const { id } = use(params)
	return <CanvasWorkspace projectId={id} />
}
