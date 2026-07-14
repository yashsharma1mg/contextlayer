import { z } from "zod"

export const uiPlanSchema = z.object({
	title: z.string(),
	summary: z.string(),
	manifestVersionId: z.string().default("legacy"),
	targetFramework: z.enum(["vite", "nextjs"]).default("vite"),
	screens: z.array(
		z.object({
			name: z.string(),
			purpose: z.string(),
			route: z.string().default("/"),
			states: z.array(z.string()).min(1),
		}),
	),
	navigation: z.array(z.string()),
	components: z.array(
		z.object({
			assetId: z.string().optional(),
			componentId: z.string(),
			screen: z.string().optional(),
			props: z.record(z.unknown()).default({}),
			variants: z.record(z.unknown()).default({}),
		}),
	),
	tokens: z.array(
		z.union([z.string(), z.object({ assetId: z.string(), name: z.string() })]),
	),
	citations: z
		.array(
			z.object({
				documentId: z.string(),
				chunkId: z.string().optional(),
				title: z.string(),
				provenance: z.record(z.unknown()).nullable().optional(),
			}),
		)
		.default([]),
	fileStructure: z.array(z.string()).min(1),
})

export type UiPlan = z.infer<typeof uiPlanSchema>

export interface ApprovedDesignAsset {
	id?: string
	name: string
	kind: string
	data: Record<string, unknown>
}

function keys(value: unknown) {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.keys(value)
		: []
}

export function validateUiPlan(
	plan: UiPlan,
	assets: ApprovedDesignAsset[],
	expectedManifestVersionId?: string,
) {
	const components = new Map(
		assets
			.filter((asset) =>
				["primitive", "component", "pattern", "template"].includes(asset.kind),
			)
			.map((asset) => [asset.name, asset]),
	)
	const tokens = new Set(
		assets
			.filter((asset) => ["foundation", "token"].includes(asset.kind))
			.map((asset) => asset.name),
	)
	const errors: string[] = []
	if (
		expectedManifestVersionId &&
		plan.manifestVersionId !== expectedManifestVersionId
	) {
		errors.push("UI plan is not pinned to the project's design-system version")
	}
	for (const component of plan.components) {
		const asset = components.get(component.componentId)
		if (!asset) {
			errors.push(`Unapproved component: ${component.componentId}`)
			continue
		}
		if (component.assetId && asset.id !== component.assetId) {
			errors.push(`Asset ID does not match ${component.componentId}`)
		}
		for (const prop of Object.keys(component.props)) {
			if (!keys(asset.data.props).includes(prop)) {
				errors.push(`Unknown prop ${prop} on ${component.componentId}`)
			}
		}
		for (const variant of Object.keys(component.variants)) {
			if (!keys(asset.data.variants).includes(variant)) {
				errors.push(`Unknown variant ${variant} on ${component.componentId}`)
			}
		}
	}
	for (const token of plan.tokens) {
		const name = typeof token === "string" ? token : token.name
		const asset = assets.find((candidate) => candidate.name === name)
		if (!tokens.has(name)) errors.push(`Unapproved token: ${name}`)
		if (typeof token !== "string" && asset?.id !== token.assetId) {
			errors.push(`Asset ID does not match token ${name}`)
		}
	}
	const states = plan.screens
		.flatMap((screen) => screen.states)
		.join(" ")
		.toLowerCase()
	for (const required of [
		"permission",
		"loading",
		"empty",
		"validation",
		"error",
		"retry",
		"quota",
		"recovery",
	]) {
		if (!states.includes(required))
			errors.push(`Missing ${required} state coverage`)
	}
	return errors
}

export function validateUiPlanCitations(
	plan: UiPlan,
	available: { documentId: string; chunkId?: string }[],
	options: { required?: boolean } = {},
) {
	const allowed = new Set(
		available.map((citation) =>
			citation.chunkId
				? `${citation.documentId}:${citation.chunkId}`
				: citation.documentId,
		),
	)
	const errors: string[] = []
	if (options.required && plan.citations.length === 0) {
		errors.push("At least one accessible knowledge citation is required")
	}
	for (const citation of plan.citations) {
		const exact = citation.chunkId
			? `${citation.documentId}:${citation.chunkId}`
			: citation.documentId
		if (!allowed.has(exact) && !allowed.has(citation.documentId)) {
			errors.push(`Unavailable citation: ${citation.documentId}`)
		}
	}
	return errors
}
