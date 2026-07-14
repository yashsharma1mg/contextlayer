"use client"

import {
	addEdge,
	Background,
	Controls,
	Handle,
	MarkerType,
	Position,
	ReactFlow,
	type Connection,
	type Edge,
	type Node,
	type NodeProps,
	type ReactFlowInstance,
	type NodeTypes,
	useEdgesState,
	useNodesState,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
	Bot,
	Box,
	Copy,
	FolderOpen,
	Globe2,
	Hand,
	History,
	Layers3,
	Link2,
	LoaderCircle,
	MessageCircle,
	MonitorUp,
	MousePointer2,
	Paperclip,
	Pencil,
	Plus,
	Send,
	StickyNote,
	Upload,
	X,
} from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { API_URL, apiDelete, apiGet, apiSend } from "@/lib/api"
import { cn } from "@/lib/utils"

type ArtifactKind =
	| "brief"
	| "requirement"
	| "user_flow"
	| "state_matrix"
	| "ux_review"
	| "interface_spec"
	| "test_case"
	| "react_prototype"

type GenerationKind = ArtifactKind | "auto"
type EdgeKind =
	| "derived_from"
	| "supports"
	| "contradicts"
	| "flows_to"
	| "implements"
	| "references"

interface WorkspaceNode {
	id: string
	kind: "artifact" | "knowledge" | "capture" | "design_asset" | "note" | "frame"
	label: string
	x: number
	y: number
	width: number
	height: number
	zIndex: number
	version: number
	data: Record<string, unknown>
	artifactId: string | null
	documentId: string | null
	captureId: string | null
	designAssetId: string | null
	artifactTitle: string | null
	artifactKind: string | null
	artifactBody: string | null
	artifactCode: string | null
	artifactSources:
		| {
				documentId: string
				title: string
				url: string | null
		  }[]
		| null
	documentTitle: string | null
	documentUrl: string | null
	documentSource: string | null
	captureTitle: string | null
	captureUrl: string | null
	captureScreenshot: string | null
	designAssetName: string | null
	designAssetKind: string | null
	designAssetDescription: string | null
}

interface WorkspaceEdge {
	id: string
	sourceNodeId: string
	targetNodeId: string
	kind: string
	label: string | null
}

interface WorkspaceComment {
	id: string
	nodeId: string | null
	authorUserId: string
	body: string
	createdAt: string
}

interface Workspace {
	project: {
		id: string
		name: string
		pinnedDesignSystemVersionId: string | null
		pinnedDesignSystem?: { name: string; version: string } | null
		canManageProjectSettings?: boolean
		canManageConnections?: boolean
		visibility?: "personal" | "team" | "org"
		teamId?: string | null
	}
	canvas: { id: string; name: string; revision: number }
	nodes: WorkspaceNode[]
	edges: WorkspaceEdge[]
	comments: WorkspaceComment[]
}

interface CanvasCardData extends Record<string, unknown> {
	record: WorkspaceNode
}

function previewDocument(html: string) {
	return html.replace(
		"<head>",
		"<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:\">",
	)
}

type CanvasFlowNode = Node<CanvasCardData, "context">

function CanvasCard({ data, selected }: NodeProps<CanvasFlowNode>) {
	const record = data.record
	const isPrototype = Boolean(record.artifactCode)
	const isReactSource = record.data.codeFormat === "tsx"
	const tone =
		record.kind === "capture"
			? "border-orange-200 bg-orange-50"
			: record.kind === "design_asset"
				? "border-violet-200 bg-violet-50"
				: record.kind === "knowledge"
					? "border-sky-200 bg-sky-50"
					: record.kind === "frame"
						? "border-dashed border-slate-300 bg-transparent"
						: "border-border bg-card"
	return (
		<div
			className={cn(
				"h-full overflow-hidden rounded-md border shadow-sm transition-shadow",
				tone,
				selected && "ring-2 ring-indigo-500/40 shadow-md",
			)}
		>
			<Handle
				type="target"
				position={Position.Left}
				className="!h-2 !w-2 !border-0 !bg-indigo-400"
			/>
			<div className="flex items-center justify-between gap-2 border-b border-black/5 px-3 py-2">
				<div className="min-w-0">
					<p className="truncate text-xs font-semibold text-foreground">
						{record.label}
					</p>
					<p className="mt-0.5 text-[10px] capitalize text-muted-foreground">
						{record.artifactKind ??
							record.designAssetKind ??
							record.documentSource ??
							record.kind.replace("_", " ")}
					</p>
				</div>
				{record.kind === "capture" && (
					<MonitorUp className="size-3.5 text-orange-500" />
				)}
				{record.kind === "design_asset" && (
					<Box className="size-3.5 text-violet-500" />
				)}
			</div>
			<div className="nodrag h-[calc(100%-3.2rem)] overflow-auto p-3">
				{isReactSource ? (
					<pre className="h-full overflow-auto whitespace-pre-wrap rounded border border-black/10 bg-slate-950 p-3 font-mono text-[10px] leading-4 text-slate-100">
						{record.artifactCode}
					</pre>
				) : isPrototype ? (
					<iframe
						title={record.label}
						sandbox=""
						srcDoc={previewDocument(record.artifactCode ?? "")}
						className="h-full min-h-48 w-full rounded border border-black/10 bg-white"
					/>
				) : record.captureScreenshot ? (
					<img
						src={record.captureScreenshot}
						alt="Captured product screen"
						className="h-full w-full rounded object-cover"
					/>
				) : record.artifactBody ? (
					<p className="whitespace-pre-line text-xs leading-5 text-muted-foreground">
						{record.artifactBody}
					</p>
				) : record.designAssetDescription ? (
					<p className="text-xs leading-5 text-muted-foreground">
						{record.designAssetDescription}
					</p>
				) : (
					<p className="text-xs leading-5 text-muted-foreground">
						{String(
							record.data.content ??
								record.data.url ??
								"Add detail or connect this to another artifact.",
						)}
					</p>
				)}
			</div>
			<Handle
				type="source"
				position={Position.Right}
				className="!h-2 !w-2 !border-0 !bg-indigo-400"
			/>
		</div>
	)
}

const nodeTypes: NodeTypes = { context: CanvasCard }

function toFlowNode(record: WorkspaceNode): CanvasFlowNode {
	return {
		id: record.id,
		type: "context",
		position: { x: record.x, y: record.y },
		data: { record },
		style: {
			width: record.width,
			height: record.height,
			zIndex: record.zIndex,
		},
	}
}

function toFlowEdge(edge: WorkspaceEdge): Edge {
	return {
		id: edge.id,
		source: edge.sourceNodeId,
		target: edge.targetNodeId,
		label: edge.label ?? undefined,
		markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
		style: { stroke: "#a5b4fc", strokeWidth: 1.5 },
		labelStyle: { fill: "#64748b", fontSize: 10 },
	}
}

const promptModes: { value: GenerationKind; label: string }[] = [
	{ value: "auto", label: "Auto" },
	{ value: "brief", label: "Brief" },
	{ value: "user_flow", label: "Flow" },
	{ value: "ux_review", label: "Review" },
	{ value: "interface_spec", label: "Spec" },
	{ value: "react_prototype", label: "Prototype" },
]

const edgeKinds: { value: EdgeKind; label: string }[] = [
	{ value: "references", label: "References" },
	{ value: "supports", label: "Supports" },
	{ value: "contradicts", label: "Contradicts" },
	{ value: "flows_to", label: "Flows to" },
	{ value: "implements", label: "Implements" },
	{ value: "derived_from", label: "Derived from" },
]

type CanvasWorkspaceProps =
	| { projectId: string; shareToken?: never }
	| { projectId?: never; shareToken: string }

export function CanvasWorkspace({
	projectId,
	shareToken,
}: CanvasWorkspaceProps) {
	const isReadOnly = Boolean(shareToken)
	const [workspace, setWorkspace] = useState<Workspace | null>(null)
	const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>([])
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
	const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
		CanvasFlowNode,
		Edge
	> | null>(null)
	const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
	const [edgeKind, setEdgeKind] = useState<EdgeKind>("references")
	const [prompt, setPrompt] = useState("")
	const [mode, setMode] = useState<GenerationKind>("auto")
	const [busy, setBusy] = useState(false)
	const [panel, setPanel] = useState<
		"context" | "comments" | "history" | "share" | "artifact" | null
	>(null)
	const [comment, setComment] = useState("")
	const [error, setError] = useState<string | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const activeProjectId = workspace?.project.id ?? projectId ?? ""

	const load = useCallback(async () => {
		const next = await apiGet<Workspace>(
			shareToken
				? `/api/shared/${shareToken}`
				: `/api/projects/${projectId}/canvas`,
		)
		setWorkspace(next)
		setNodes(next.nodes.map(toFlowNode))
		setEdges(next.edges.map(toFlowEdge))
	}, [projectId, setEdges, setNodes, shareToken])

	useEffect(() => {
		load().catch((cause) => setError(cause.message))
	}, [load])

	const selectedRecord = useMemo(
		() =>
			workspace?.nodes.find((node) => node.id === selectedNodeIds[0]) ?? null,
		[selectedNodeIds, workspace],
	)

	const focusSource = useCallback(
		(documentId: string) => {
			const source = workspace?.nodes.find(
				(node) => node.documentId === documentId,
			)
			if (!source) {
				setError("This source has not been placed on the canvas.")
				return
			}
			setSelectedNodeIds([source.id])
			setNodes((current) =>
				current.map((node) => ({ ...node, selected: node.id === source.id })),
			)
			flowInstance?.setCenter(
				source.x + source.width / 2,
				source.y + source.height / 2,
				{ duration: 250, zoom: 1 },
			)
		},
		[flowInstance, setNodes, workspace],
	)

	const persistNode = useCallback(
		async (_: MouseEvent | TouchEvent, node: CanvasFlowNode) => {
			if (!workspace) return
			const record = workspace.nodes.find((item) => item.id === node.id)
			if (!record) return
			try {
				const result = await apiSend<{ nodes: WorkspaceNode[] }>(
					"PATCH",
					`/api/canvases/${workspace.canvas.id}/layout`,
					{
						nodes: [
							{
								id: node.id,
								version: record.version,
								x: Math.round(node.position.x),
								y: Math.round(node.position.y),
								width: record.width,
								height: record.height,
							},
						],
					},
				)
				setWorkspace((current) =>
					current
						? {
								...current,
								nodes: current.nodes.map((item) =>
									item.id === node.id ? { ...item, ...result.nodes[0] } : item,
								),
							}
						: current,
				)
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "Could not save canvas position",
				)
				load().catch(() => undefined)
			}
		},
		[load, workspace],
	)

	const connect = useCallback(
		async (connection: Connection) => {
			if (!workspace || !connection.source || !connection.target) return
			try {
				const result = await apiSend<{ edge: WorkspaceEdge }>(
					"POST",
					`/api/canvases/${workspace.canvas.id}/edges`,
					{
						sourceNodeId: connection.source,
						targetNodeId: connection.target,
						kind: edgeKind,
					},
				)
				setEdges((current) => addEdge(toFlowEdge(result.edge), current))
				setWorkspace((current) =>
					current
						? { ...current, edges: [...current.edges, result.edge] }
						: current,
				)
			} catch (cause) {
				setError(
					cause instanceof Error ? cause.message : "Could not connect nodes",
				)
			}
		},
		[edgeKind, setEdges, workspace],
	)

	const removeNodes = useCallback(
		async (deleted: CanvasFlowNode[]) => {
			if (!workspace || deleted.length === 0) return
			try {
				await Promise.all(
					deleted.map((node) =>
						apiDelete(`/api/canvases/${workspace.canvas.id}/nodes/${node.id}`),
					),
				)
				const deletedIds = new Set(deleted.map((node) => node.id))
				setWorkspace((current) =>
					current
						? {
								...current,
								nodes: current.nodes.filter((node) => !deletedIds.has(node.id)),
								edges: current.edges.filter(
									(edge) =>
										!deletedIds.has(edge.sourceNodeId) &&
										!deletedIds.has(edge.targetNodeId),
								),
								comments: current.comments.filter(
									(comment) =>
										!comment.nodeId || !deletedIds.has(comment.nodeId),
								),
							}
						: current,
				)
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "Could not delete canvas node",
				)
				load().catch(() => undefined)
			}
		},
		[load, workspace],
	)

	const removeEdges = useCallback(
		async (deleted: Edge[]) => {
			if (!workspace || deleted.length === 0) return
			try {
				await Promise.all(
					deleted.map((edge) =>
						apiDelete(`/api/canvases/${workspace.canvas.id}/edges/${edge.id}`),
					),
				)
				const deletedIds = new Set(deleted.map((edge) => edge.id))
				setWorkspace((current) =>
					current
						? {
								...current,
								edges: current.edges.filter((edge) => !deletedIds.has(edge.id)),
							}
						: current,
				)
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "Could not delete canvas connection",
				)
				load().catch(() => undefined)
			}
		},
		[load, workspace],
	)

	const appendNode = useCallback(
		(node: WorkspaceNode) => {
			setWorkspace((current) =>
				current && !current.nodes.some((item) => item.id === node.id)
					? { ...current, nodes: [...current.nodes, node] }
					: current,
			)
			setNodes((current) =>
				current.some((item) => item.id === node.id)
					? current
					: [...current, toFlowNode(node)],
			)
		},
		[setNodes],
	)

	async function addNote(kind: "note" | "frame") {
		if (!workspace) return
		const result = await apiSend<{ node: WorkspaceNode }>(
			"POST",
			`/api/canvases/${workspace.canvas.id}/nodes`,
			{
				kind,
				label: kind === "note" ? "Untitled note" : "New group",
				x: 80 + workspace.nodes.length * 24,
				y: 80 + workspace.nodes.length * 24,
				width: kind === "frame" ? 680 : 320,
				height: kind === "frame" ? 440 : 180,
				data: {
					content:
						kind === "note" ? "Add a thought, decision, or question." : "",
				},
			},
		)
		setWorkspace((current) =>
			current
				? { ...current, nodes: [...current.nodes, result.node] }
				: current,
		)
		setNodes((current) => [...current, toFlowNode(result.node)])
	}

	async function generate(event: React.FormEvent) {
		event.preventDefault()
		if (!workspace || !prompt.trim()) return
		setBusy(true)
		setError(null)
		try {
			const result = await apiSend<{ artifact: { node: WorkspaceNode } }>(
				"POST",
				`/api/projects/${activeProjectId}/generate`,
				{
					prompt,
					kind: mode,
					selectedNodeIds,
				},
			)
			setPrompt("")
			setWorkspace((current) =>
				current
					? { ...current, nodes: [...current.nodes, result.artifact.node] }
					: current,
			)
			setNodes((current) => [...current, toFlowNode(result.artifact.node)])
			setSelectedNodeIds([result.artifact.node.id])
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Generation failed")
		} finally {
			setBusy(false)
		}
	}

	async function addComment(event: React.FormEvent) {
		event.preventDefault()
		if (!workspace || !comment.trim()) return
		const result = await apiSend<{ comment: WorkspaceComment }>(
			"POST",
			`/api/canvases/${workspace.canvas.id}/comments`,
			{
				nodeId: selectedNodeIds[0],
				body: comment,
			},
		)
		setWorkspace((current) =>
			current
				? { ...current, comments: [...current.comments, result.comment] }
				: current,
		)
		setComment("")
	}

	async function upload(file: File) {
		if (!workspace) return
		setBusy(true)
		try {
			const form = new FormData()
			form.append("file", file)
			form.append("scope", "org")
			const response = await fetch(`${API_URL}/api/memories/upload`, {
				method: "POST",
				credentials: "include",
				body: form,
			})
			if (!response.ok) throw new Error("Upload failed")
			const uploaded = (await response.json()) as {
				document: { id: string }
			}
			const result = await apiSend<{ node: WorkspaceNode }>(
				"POST",
				`/api/projects/${activeProjectId}/documents/${uploaded.document.id}/nodes`,
				{
					x: 120 + workspace.nodes.length * 24,
					y: 140 + workspace.nodes.length * 24,
				},
			)
			appendNode(result.node)
			setPanel("context")
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Upload failed")
		} finally {
			setBusy(false)
		}
	}

	if (!workspace) {
		return (
			<div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
				{error ?? "Loading workspace..."}
			</div>
		)
	}

	const nodeComments = workspace.comments.filter(
		(item) => item.nodeId === selectedNodeIds[0],
	)
	return (
		<div className="relative h-screen overflow-hidden bg-[#fbfaf8] text-foreground">
			<ReactFlow<CanvasFlowNode, Edge>
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onNodesDelete={isReadOnly ? undefined : removeNodes}
				onEdgesDelete={isReadOnly ? undefined : removeEdges}
				onNodeDragStop={isReadOnly ? undefined : persistNode}
				onConnect={isReadOnly ? undefined : connect}
				nodesDraggable={!isReadOnly}
				nodesConnectable={!isReadOnly}
				elementsSelectable={!isReadOnly}
				onInit={setFlowInstance}
				onSelectionChange={({ nodes: selected }) => {
					const next = selected.map((node) => node.id)
					setSelectedNodeIds((current) =>
						current.length === next.length &&
						current.every((nodeId, index) => nodeId === next[index])
							? current
							: next,
					)
				}}
				deleteKeyCode={isReadOnly ? null : ["Backspace", "Delete"]}
				fitView
				minZoom={0.2}
				maxZoom={2}
				className="contextlayer-flow"
			>
				<Background gap={18} size={1.25} color="#ddd9d4" />
				<Controls
					showInteractive={false}
					className="!bottom-5 !left-5 !shadow-sm"
				/>
			</ReactFlow>

			<div className="absolute left-5 top-5 z-10 flex items-center rounded-lg border border-black/10 bg-white/95 shadow-sm backdrop-blur">
				<Link
					href="/projects"
					className="border-r border-black/10 px-3 py-2 text-sm font-semibold tracking-tight"
				>
					Context Layer
				</Link>
				<div className="px-3 py-2">
					<p className="max-w-48 truncate text-sm font-medium">
						{workspace.project.name}
					</p>
					<p className="text-[10px] text-muted-foreground">
						{workspace.canvas.name}
					</p>
				</div>
			</div>

			<div className="absolute right-5 top-5 z-10 flex items-center rounded-lg border border-black/10 bg-white/95 shadow-sm backdrop-blur">
				{isReadOnly ? (
					<span className="px-3 py-2 text-xs font-medium text-muted-foreground">
						Read only
					</span>
				) : (
					<>
						<SimpleTooltip label="Source connections">
							<Button
								aria-label="Source connections"
								variant="ghost"
								size="icon"
								onClick={() => setPanel("context")}
							>
								<Link2 />
							</Button>
						</SimpleTooltip>
						<SimpleTooltip label="Canvas history">
							<Button
								aria-label="Canvas history"
								variant="ghost"
								size="icon"
								onClick={() => setPanel("history")}
							>
								<History />
							</Button>
						</SimpleTooltip>
						<SimpleTooltip label="Design system">
							<Button
								aria-label="Design system"
								variant="ghost"
								size="icon"
								onClick={() => setPanel("context")}
							>
								<Layers3 />
							</Button>
						</SimpleTooltip>
						<span className="max-w-36 truncate px-2 text-[10px] text-muted-foreground">
							{workspace.project.pinnedDesignSystem
								? `${workspace.project.pinnedDesignSystem.name} v${workspace.project.pinnedDesignSystem.version}`
								: "No system"}
						</span>
						<SimpleTooltip label="Artifact revisions">
							<Button
								aria-label="Artifact revisions"
								variant="ghost"
								size="icon"
								onClick={() => {
									if (selectedRecord?.artifactId) setPanel("artifact")
									else setError("Select a generated artifact first.")
								}}
							>
								<Pencil />
							</Button>
						</SimpleTooltip>
						<div className="h-6 border-l border-black/10" />
						<Button
							size="sm"
							className="mr-1 bg-indigo-600 hover:bg-indigo-700"
							onClick={() => setPanel("share")}
						>
							Share
						</Button>
					</>
				)}
			</div>

			{!isReadOnly && (
				<div className="absolute left-5 top-28 z-10 flex w-10 flex-col gap-1 rounded-lg border border-black/10 bg-white/95 p-1 shadow-sm backdrop-blur">
					<SimpleTooltip label="Select" side="right">
						<Button aria-label="Select" variant="secondary" size="icon">
							<MousePointer2 />
						</Button>
					</SimpleTooltip>
					<SimpleTooltip label="Pan" side="right">
						<Button aria-label="Pan" variant="ghost" size="icon">
							<Hand />
						</Button>
					</SimpleTooltip>
					<div className="my-0.5 border-t border-black/10" />
					<SimpleTooltip label="Add note" side="right">
						<Button
							aria-label="Add note"
							variant="ghost"
							size="icon"
							onClick={() => addNote("note")}
						>
							<StickyNote />
						</Button>
					</SimpleTooltip>
					<SimpleTooltip label="Add group" side="right">
						<Button
							aria-label="Add group"
							variant="ghost"
							size="icon"
							onClick={() => addNote("frame")}
						>
							<FolderOpen />
						</Button>
					</SimpleTooltip>
					<SimpleTooltip label="Capture product" side="right">
						<Button
							aria-label="Capture product"
							variant="ghost"
							size="icon"
							onClick={() =>
								setError(
									"Use the Context Layer Capture extension on the page you want to add.",
								)
							}
						>
							<MonitorUp />
						</Button>
					</SimpleTooltip>
					<SimpleTooltip label="Upload context" side="right">
						<Button
							aria-label="Upload context"
							variant="ghost"
							size="icon"
							onClick={() => inputRef.current?.click()}
						>
							<Upload />
						</Button>
					</SimpleTooltip>
					<SimpleTooltip label="Comments" side="right">
						<Button
							aria-label="Comments"
							variant="ghost"
							size="icon"
							onClick={() => setPanel("comments")}
						>
							<MessageCircle />
						</Button>
					</SimpleTooltip>
				</div>
			)}

			{!isReadOnly && panel && (
				<div className="absolute bottom-5 right-5 top-24 z-20 w-[22rem] overflow-auto rounded-lg border border-black/10 bg-white/95 p-4 shadow-lg backdrop-blur">
					<div className="mb-4 flex items-center justify-between">
						<p className="text-sm font-semibold capitalize">{panel}</p>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setPanel(null)}
						>
							<X />
						</Button>
					</div>
					{panel === "context" && (
						<ContextPanel
							projectId={activeProjectId}
							pinnedVersion={workspace.project.pinnedDesignSystemVersionId}
							canManageSettings={
								workspace.project.canManageProjectSettings ?? false
							}
							canManageConnections={
								workspace.project.canManageConnections ?? false
							}
							onNodeAdded={appendNode}
							onProjectUpdated={load}
						/>
					)}
					{panel === "history" && (
						<HistoryPanel canvasId={workspace.canvas.id} onRestored={load} />
					)}
					{panel === "share" && (
						<SharePanel
							projectId={activeProjectId}
							visibility={workspace.project.visibility ?? "personal"}
							teamId={workspace.project.teamId ?? null}
						/>
					)}
					{panel === "artifact" && selectedRecord?.artifactId && (
						<ArtifactPanel
							key={selectedRecord.artifactId}
							artifactId={selectedRecord.artifactId}
							title={selectedRecord.artifactTitle ?? selectedRecord.label}
							body={selectedRecord.artifactBody ?? ""}
							sources={selectedRecord.artifactSources ?? []}
							onSourceSelected={focusSource}
							onSaved={load}
							onBranched={load}
						/>
					)}
					{panel === "comments" && (
						<div className="space-y-3">
							{selectedRecord ? (
								<p className="text-xs text-muted-foreground">
									Commenting on {selectedRecord.label}
								</p>
							) : (
								<p className="text-xs text-muted-foreground">
									Select a node to attach a comment.
								</p>
							)}
							{nodeComments.map((item) => (
								<div
									key={item.id}
									className="rounded border border-border p-2 text-xs"
								>
									<p>{item.body}</p>
									<p className="mt-1 text-[10px] text-muted-foreground">
										{new Date(item.createdAt).toLocaleString()}
									</p>
								</div>
							))}
							<form onSubmit={addComment} className="space-y-2">
								<Input
									value={comment}
									onChange={(event) => setComment(event.target.value)}
									placeholder="Leave a review note"
									disabled={!selectedRecord}
								/>
								<Button type="submit" size="sm" disabled={!selectedRecord}>
									Comment
								</Button>
							</form>
						</div>
					)}
				</div>
			)}

			{!isReadOnly && (
				<form
					onSubmit={generate}
					className="absolute bottom-5 left-1/2 z-10 w-[min(40rem,calc(100%-8rem))] -translate-x-1/2 rounded-xl border border-black/10 bg-white/95 p-3 shadow-lg backdrop-blur"
				>
					<div className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500/20">
						<Bot className="size-4 text-indigo-600" />
						<Input
							className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
							placeholder="Describe what you want to explore or build"
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
						/>
						<Button
							type="submit"
							size="icon-sm"
							disabled={busy || !prompt.trim()}
						>
							{busy ? <LoaderCircle className="animate-spin" /> : <Send />}
						</Button>
					</div>
					<div className="mt-2 flex items-center justify-between gap-2">
						<div className="flex items-center gap-1 overflow-x-auto">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => inputRef.current?.click()}
							>
								<Paperclip /> Add context
							</Button>
							{promptModes.map((item) => (
								<button
									key={item.value}
									type="button"
									onClick={() => setMode(item.value)}
									className={cn(
										"rounded px-2 py-1 text-xs",
										mode === item.value
											? "bg-indigo-50 text-indigo-700"
											: "text-muted-foreground hover:bg-muted",
									)}
								>
									{item.label}
								</button>
							))}
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<select
								aria-label="New connection relationship"
								title="New connection relationship"
								value={edgeKind}
								onChange={(event) =>
									setEdgeKind(event.target.value as EdgeKind)
								}
								className="h-7 max-w-28 rounded border border-border bg-white px-1.5 text-[10px] text-muted-foreground"
							>
								{edgeKinds.map((kind) => (
									<option key={kind.value} value={kind.value}>
										{kind.label}
									</option>
								))}
							</select>
							<span className="text-xs text-muted-foreground">
								{selectedNodeIds.length
									? `${selectedNodeIds.length} context selected`
									: "Auto"}
							</span>
						</div>
					</div>
				</form>
			)}

			{!isReadOnly && (
				<input
					ref={inputRef}
					className="hidden"
					type="file"
					onChange={(event) => {
						const file = event.target.files?.[0]
						if (file) upload(file).catch(() => undefined)
						event.currentTarget.value = ""
					}}
				/>
			)}
			{error && (
				<div className="absolute bottom-36 left-1/2 z-30 max-w-md -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
					{error}
				</div>
			)}
		</div>
	)
}

function ContextPanel({
	projectId,
	pinnedVersion,
	canManageSettings,
	canManageConnections,
	onNodeAdded,
	onProjectUpdated,
}: {
	projectId: string
	pinnedVersion: string | null
	canManageSettings: boolean
	canManageConnections: boolean
	onNodeAdded: (node: WorkspaceNode) => void
	onProjectUpdated: () => Promise<void>
}) {
	const [assets, setAssets] = useState<
		{ id: string; name: string; kind: string; description: string | null }[]
	>([])
	const [captureToken, setCaptureToken] = useState<string | null>(null)
	const [busyAssetId, setBusyAssetId] = useState<string | null>(null)
	const [versions, setVersions] = useState<
		{ id: string; name: string; version: string }[]
	>([])
	const [pinning, setPinning] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [assetQuery, setAssetQuery] = useState("")
	const [connections, setConnections] = useState({
		figma: false,
		confluence: false,
	})
	const [figmaFileUrl, setFigmaFileUrl] = useState("")
	const [watchingFigma, setWatchingFigma] = useState(false)
	const [figmaNotice, setFigmaNotice] = useState<string | null>(null)
	const loadAssets = useCallback(async () => {
		const result = await apiGet<{
			assets: {
				id: string
				name: string
				kind: string
				description: string | null
			}[]
		}>(`/api/projects/${projectId}/design-assets`)
		setAssets(result.assets)
	}, [projectId])
	useEffect(() => {
		loadAssets().catch(() => undefined)
		apiGet<{ versions: { id: string; name: string; version: string }[] }>(
			"/api/design-system-versions",
		)
			.then((result) => setVersions(result.versions))
			.catch(() => undefined)
	}, [loadAssets])
	useEffect(() => {
		Promise.all([
			apiGet<{ connected: boolean }>("/api/connections/figma/status"),
			apiGet<{ connected: boolean }>("/api/connections/confluence/status"),
		])
			.then(([figma, confluence]) =>
				setConnections({
					figma: figma.connected,
					confluence: confluence.connected,
				}),
			)
			.catch(() => undefined)
	}, [])

	async function pinDesignSystem(versionId: string) {
		setPinning(true)
		setError(null)
		try {
			await apiSend("PATCH", `/api/projects/${projectId}/design-system`, {
				versionId: versionId || null,
			})
			await Promise.all([onProjectUpdated(), loadAssets()])
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not pin design system",
			)
		} finally {
			setPinning(false)
		}
	}

	async function addAsset(assetId: string) {
		setBusyAssetId(assetId)
		try {
			const result = await apiSend<{ node: WorkspaceNode }>(
				"POST",
				`/api/projects/${projectId}/design-assets/${assetId}/nodes`,
				{ x: 180 + assets.length * 12, y: 180 + assets.length * 12 },
			)
			onNodeAdded(result.node)
		} finally {
			setBusyAssetId(null)
		}
	}

	async function createCaptureToken() {
		const result = await apiSend<{ token: string }>(
			"POST",
			`/api/projects/${projectId}/capture-tokens`,
			{},
		)
		setCaptureToken(result.token)
	}

	async function watchFigmaFile(event: React.FormEvent) {
		event.preventDefault()
		setWatchingFigma(true)
		setFigmaNotice(null)
		try {
			await apiSend("POST", "/api/connections/figma/watch", {
				fileUrl: figmaFileUrl,
			})
			setFigmaFileUrl("")
			setFigmaNotice("Figma file registered for the next sync.")
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not register Figma file",
			)
		} finally {
			setWatchingFigma(false)
		}
	}

	const visibleAssets = assets.filter((asset) =>
		`${asset.name} ${asset.kind} ${asset.description ?? ""}`
			.toLowerCase()
			.includes(assetQuery.trim().toLowerCase()),
	)

	return (
		<div className="space-y-4">
			<div>
				<p className="text-xs font-medium">Design system</p>
				<select
					value={pinnedVersion ?? ""}
					disabled={pinning || !canManageSettings}
					onChange={(event) => pinDesignSystem(event.target.value)}
					className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
				>
					<option value="">No pinned version</option>
					{versions.map((version) => (
						<option key={version.id} value={version.id}>
							{version.name} v{version.version}
						</option>
					))}
				</select>
				{!canManageSettings && (
					<p className="mt-1 text-[10px] text-muted-foreground">
						Only the project owner can change this version.
					</p>
				)}
			</div>
			<div className="space-y-2">
				<Input
					value={assetQuery}
					onChange={(event) => setAssetQuery(event.target.value)}
					placeholder="Search design assets"
				/>
				{visibleAssets.map((asset) => (
					<div
						key={asset.id}
						className="flex items-center justify-between gap-2 rounded border border-border p-2"
					>
						<div className="min-w-0">
							<p className="truncate text-xs font-medium">{asset.name}</p>
							<p className="mt-0.5 text-[10px] capitalize text-muted-foreground">
								{asset.kind}
							</p>
						</div>
						<Button
							variant="outline"
							size="xs"
							disabled={busyAssetId === asset.id}
							onClick={() => addAsset(asset.id)}
						>
							Add
						</Button>
					</div>
				))}
				{assets.length === 0 && (
					<p className="text-xs text-muted-foreground">
						Connect a design system from the project settings to ground
						prototypes in real components.
					</p>
				)}
				{assets.length > 0 && visibleAssets.length === 0 && (
					<p className="text-xs text-muted-foreground">No matching assets.</p>
				)}
			</div>
			<div className="border-t border-border pt-3">
				<Button variant="outline" size="sm" onClick={createCaptureToken}>
					<MonitorUp /> Capture extension token
				</Button>
				{captureToken && (
					<p className="mt-2 break-all rounded border border-border bg-muted p-2 font-mono text-[10px]">
						{captureToken}
					</p>
				)}
			</div>
			<div className="space-y-2 border-t border-border pt-3">
				<p className="text-xs font-medium">Connections</p>
				<div className="flex items-center justify-between gap-2 text-xs">
					<span className="text-muted-foreground">
						Figma {connections.figma ? "connected" : "not connected"}
					</span>
					{canManageConnections && (
						<Button asChild size="xs" variant="outline">
							<a href={`${API_URL}/api/connections/figma/start`}>
								{connections.figma ? "Reconnect" : "Connect"}
							</a>
						</Button>
					)}
				</div>
				<div className="flex items-center justify-between gap-2 text-xs">
					<span className="text-muted-foreground">
						Confluence {connections.confluence ? "connected" : "not connected"}
					</span>
					{canManageConnections && (
						<Button asChild size="xs" variant="outline">
							<a href={`${API_URL}/api/connections/confluence/start`}>
								{connections.confluence ? "Reconnect" : "Connect"}
							</a>
						</Button>
					)}
				</div>
				{connections.figma && canManageConnections && (
					<form onSubmit={watchFigmaFile} className="flex gap-1">
						<Input
							type="url"
							value={figmaFileUrl}
							onChange={(event) => setFigmaFileUrl(event.target.value)}
							placeholder="Figma file URL"
							required
						/>
						<Button type="submit" size="xs" disabled={watchingFigma}>
							Watch
						</Button>
					</form>
				)}
				{figmaNotice && (
					<p className="text-[10px] text-muted-foreground">{figmaNotice}</p>
				)}
				{!canManageConnections && (
					<p className="text-[10px] text-muted-foreground">
						Only organization owners and admins can manage connections.
					</p>
				)}
			</div>
			<Link
				href="/projects"
				className="inline-flex items-center gap-1 text-xs text-indigo-600"
			>
				<Plus className="size-3" /> Manage projects
			</Link>
			{error && <p className="text-xs text-red-600">{error}</p>}
		</div>
	)
}

function ArtifactPanel({
	artifactId,
	title: initialTitle,
	body: initialBody,
	sources,
	onSourceSelected,
	onSaved,
	onBranched,
}: {
	artifactId: string
	title: string
	body: string
	sources: { documentId: string; title: string; url: string | null }[]
	onSourceSelected: (documentId: string) => void
	onSaved: () => Promise<void>
	onBranched: () => Promise<void>
}) {
	const [title, setTitle] = useState(initialTitle)
	const [body, setBody] = useState(initialBody)
	const [revisions, setRevisions] = useState<
		{
			id: string
			version: number
			title: string
			content: Record<string, unknown>
			generationInput: { uiPlan?: unknown } | null
			createdAt: string
		}[]
	>([])
	const [comparisonId, setComparisonId] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const loadRevisions = useCallback(async () => {
		const result = await apiGet<{
			revisions: {
				id: string
				version: number
				title: string
				content: Record<string, unknown>
				generationInput: { uiPlan?: unknown } | null
				createdAt: string
			}[]
		}>(`/api/artifacts/${artifactId}/revisions`)
		setRevisions(result.revisions)
	}, [artifactId])

	useEffect(() => {
		loadRevisions().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Could not load versions",
			),
		)
	}, [loadRevisions])

	async function save(event: React.FormEvent) {
		event.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await apiSend("PATCH", `/api/artifacts/${artifactId}`, { title, body })
			await Promise.all([onSaved(), loadRevisions()])
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save artifact",
			)
		} finally {
			setBusy(false)
		}
	}

	async function branch(revisionId: string) {
		setBusy(true)
		setError(null)
		try {
			await apiSend("POST", `/api/artifacts/${artifactId}/branch`, {
				revisionId,
			})
			await onBranched()
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not branch artifact",
			)
		} finally {
			setBusy(false)
		}
	}

	const currentRevision = revisions[0]
	const comparison = revisions.find((revision) => revision.id === comparisonId)
	const uiPlan = currentRevision?.generationInput?.uiPlan
	const hasUiPlan = uiPlan !== undefined && uiPlan !== null
	const revisionBody = (revision: (typeof revisions)[number]) =>
		typeof revision.content.body === "string" ? revision.content.body : ""

	return (
		<div className="space-y-4">
			<form onSubmit={save} className="space-y-3">
				<Input
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					placeholder="Artifact title"
				/>
				<textarea
					value={body}
					onChange={(event) => setBody(event.target.value)}
					className="min-h-44 w-full resize-y rounded-md border border-input bg-background p-2 text-xs leading-5"
					placeholder="Artifact content"
				/>
				<Button type="submit" size="sm" disabled={busy || !title.trim()}>
					{busy ? "Saving" : "Save revision"}
				</Button>
			</form>
			<div className="space-y-2 border-t border-border pt-4">
				<p className="text-xs font-medium">Version history</p>
				{revisions.map((revision) => (
					<div key={revision.id} className="rounded border border-border p-2">
						<div className="flex items-start justify-between gap-2">
							<div className="min-w-0">
								<p className="text-xs font-medium">v{revision.version}</p>
								<p className="truncate text-[11px] text-muted-foreground">
									{revision.title}
								</p>
								<p className="mt-0.5 text-[10px] text-muted-foreground">
									{new Date(revision.createdAt).toLocaleString()}
								</p>
							</div>
							<div className="flex shrink-0 gap-1">
								{revision.id !== currentRevision?.id && (
									<Button
										variant="ghost"
										size="xs"
										onClick={() => setComparisonId(revision.id)}
									>
										Compare
									</Button>
								)}
								<Button
									variant="ghost"
									size="xs"
									disabled={busy}
									onClick={() => branch(revision.id)}
								>
									Branch
								</Button>
							</div>
						</div>
					</div>
				))}
			</div>
			{sources.length > 0 && (
				<div className="space-y-2 border-t border-border pt-4">
					<p className="text-xs font-medium">Evidence</p>
					{sources.map((source) => (
						<Button
							key={source.documentId}
							type="button"
							variant="ghost"
							size="xs"
							className="max-w-full justify-start truncate"
							onClick={() => onSourceSelected(source.documentId)}
						>
							{source.title}
						</Button>
					))}
				</div>
			)}
			{hasUiPlan && (
				<details className="border-t border-border pt-4">
					<summary className="cursor-pointer text-xs font-medium">
						Validated UI plan
					</summary>
					<pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-2 text-[10px] leading-4">
						{JSON.stringify(uiPlan, null, 2) ?? ""}
					</pre>
				</details>
			)}
			{comparison && currentRevision && (
				<div className="space-y-2 border-t border-border pt-4">
					<div className="flex items-center justify-between">
						<p className="text-xs font-medium">
							v{comparison.version} compared with v{currentRevision.version}
						</p>
						<Button
							variant="ghost"
							size="xs"
							onClick={() => setComparisonId(null)}
						>
							Close
						</Button>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-2 text-[10px] leading-4">
							{revisionBody(comparison)}
						</pre>
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border p-2 text-[10px] leading-4">
							{revisionBody(currentRevision)}
						</pre>
					</div>
				</div>
			)}
			{error && <p className="text-xs text-red-600">{error}</p>}
		</div>
	)
}

function SharePanel({
	projectId,
	visibility: initialVisibility,
	teamId,
}: {
	projectId: string
	visibility: "personal" | "team" | "org"
	teamId: string | null
}) {
	const [visibility, setVisibility] = useState(initialVisibility)
	const [selectedTeamId, setSelectedTeamId] = useState(teamId)
	const [shareUrl, setShareUrl] = useState<string | null>(null)
	const [links, setLinks] = useState<
		{
			id: string
			expiresAt: string
			revokedAt: string | null
			createdAt: string
		}[]
	>([])
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [teams, setTeams] = useState<{ id: string; name: string }[]>([])

	const loadLinks = useCallback(async () => {
		const result = await apiGet<{ shareLinks: typeof links }>(
			`/api/projects/${projectId}/share-links`,
		)
		setLinks(result.shareLinks)
	}, [projectId])

	useEffect(() => {
		loadLinks().catch((cause) =>
			setError(cause instanceof Error ? cause.message : "Could not load links"),
		)
	}, [loadLinks])

	useEffect(() => {
		apiGet<{ teams: { id: string; name: string }[] }>(
			`/api/projects/${projectId}/sharing-options`,
		)
			.then((result) => setTeams(result.teams))
			.catch(() => undefined)
	}, [projectId])

	async function updateVisibility(value: string) {
		const [nextVisibility, nextTeamId] = value.split(":") as [
			"personal" | "team" | "org",
			string | undefined,
		]
		setBusy(true)
		setError(null)
		try {
			await apiSend("PATCH", `/api/projects/${projectId}/share`, {
				visibility: nextVisibility,
				...(nextVisibility === "team" ? { teamId: nextTeamId } : {}),
			})
			setVisibility(nextVisibility)
			setSelectedTeamId(nextVisibility === "team" ? (nextTeamId ?? null) : null)
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not update sharing",
			)
		} finally {
			setBusy(false)
		}
	}

	async function createLink() {
		setBusy(true)
		setError(null)
		try {
			const result = await apiSend<{
				token: string
				shareLink: { id: string; expiresAt: string }
			}>("POST", `/api/projects/${projectId}/share-links`, {})
			setShareUrl(`${window.location.origin}/share/${result.token}`)
			await loadLinks()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not create link")
		} finally {
			setBusy(false)
		}
	}

	async function revokeLink(linkId: string) {
		setBusy(true)
		setError(null)
		try {
			await apiDelete(`/api/projects/${projectId}/share-links/${linkId}`)
			await loadLinks()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not revoke link")
		} finally {
			setBusy(false)
		}
	}

	async function copyLink() {
		if (!shareUrl) return
		try {
			await navigator.clipboard.writeText(shareUrl)
		} catch {
			setError("Could not copy the link")
		}
	}

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<label className="text-xs font-medium" htmlFor="project-visibility">
					Project access
				</label>
				<select
					id="project-visibility"
					value={
						visibility === "team" && selectedTeamId
							? `team:${selectedTeamId}`
							: visibility
					}
					disabled={busy}
					onChange={(event) => updateVisibility(event.target.value)}
					className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
				>
					<option value="personal">Only me</option>
					<option value="org">Everyone in this organization</option>
					{teams.map((team) => (
						<option key={team.id} value={`team:${team.id}`}>
							{team.name}
						</option>
					))}
				</select>
			</div>
			<div className="border-t border-border pt-4">
				<p className="text-xs font-medium">Read-only link</p>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">
					Anyone with this link can view the canvas until it expires in 30 days.
				</p>
				<Button
					className="mt-3 w-full"
					variant="outline"
					disabled={busy}
					onClick={createLink}
				>
					<Globe2 /> Create read-only link
				</Button>
				{shareUrl && (
					<div className="mt-3 flex gap-2">
						<Input
							value={shareUrl}
							readOnly
							aria-label="Read-only share link"
						/>
						<Button
							variant="outline"
							size="icon"
							aria-label="Copy share link"
							onClick={copyLink}
						>
							<Copy />
						</Button>
					</div>
				)}
			</div>
			<div className="space-y-2 border-t border-border pt-4">
				<p className="text-xs font-medium">Issued links</p>
				{links
					.filter((link) => !link.revokedAt)
					.map((link) => (
						<div
							key={link.id}
							className="flex items-center justify-between gap-2 rounded border border-border p-2"
						>
							<p className="text-[11px] text-muted-foreground">
								Expires {new Date(link.expiresAt).toLocaleDateString()}
							</p>
							<Button
								variant="ghost"
								size="xs"
								disabled={busy}
								onClick={() => revokeLink(link.id)}
							>
								Revoke
							</Button>
						</div>
					))}
				{links.filter((link) => !link.revokedAt).length === 0 && (
					<p className="text-xs text-muted-foreground">No active links.</p>
				)}
			</div>
			{error && <p className="text-xs text-red-600">{error}</p>}
		</div>
	)
}

function HistoryPanel({
	canvasId,
	onRestored,
}: {
	canvasId: string
	onRestored: () => Promise<void>
}) {
	const [items, setItems] = useState<
		{ id: string; reason: string; createdAt: string }[]
	>([])
	const [restoring, setRestoring] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const loadHistory = useCallback(async () => {
		const result = await apiGet<{
			revisions: { id: string; reason: string; createdAt: string }[]
		}>(`/api/canvases/${canvasId}/history`)
		setItems(result.revisions)
	}, [canvasId])
	useEffect(() => {
		loadHistory().catch(() => undefined)
	}, [loadHistory])

	async function restore(item: { id: string; reason: string }) {
		if (!window.confirm(`Restore the canvas to "${item.reason}"?`)) return
		setRestoring(item.id)
		setError(null)
		try {
			await apiSend(
				"POST",
				`/api/canvases/${canvasId}/revisions/${item.id}/restore`,
				{},
			)
			await onRestored()
			await loadHistory()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not restore")
		} finally {
			setRestoring(null)
		}
	}
	return (
		<div className="space-y-2">
			{items.map((item) => (
				<div
					key={item.id}
					className="flex items-center justify-between gap-2 rounded border border-border p-2"
				>
					<div className="min-w-0">
						<p className="truncate text-xs font-medium capitalize">
							{item.reason}
						</p>
						<p className="mt-0.5 text-[10px] text-muted-foreground">
							{new Date(item.createdAt).toLocaleString()}
						</p>
					</div>
					<Button
						variant="ghost"
						size="xs"
						disabled={restoring !== null}
						onClick={() => restore(item)}
					>
						{restoring === item.id ? "Restoring" : "Restore"}
					</Button>
				</div>
			))}
			{items.length === 0 && (
				<p className="text-xs text-muted-foreground">
					History checkpoints appear before generation and destructive changes.
				</p>
			)}
			{error && <p className="text-xs text-red-600">{error}</p>}
		</div>
	)
}
