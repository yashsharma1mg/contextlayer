import { z } from "zod"

export const uiPlanSchema = z.object({
	title: z.string(),
	summary: z.string(),
	screens: z.array(
		z.object({
			name: z.string(),
			purpose: z.string(),
			states: z.array(z.string()).min(1),
		}),
	),
	navigation: z.array(z.string()),
	components: z.array(
		z.object({
			componentId: z.string(),
			props: z.record(z.unknown()).default({}),
			variants: z.record(z.unknown()).default({}),
		}),
	),
	tokens: z.array(z.string()),
	fileStructure: z.array(z.string()).min(1),
})

export type UiPlan = z.infer<typeof uiPlanSchema>

export interface ApprovedDesignAsset {
	name: string
	kind: string
	data: Record<string, unknown>
}

function keys(value: unknown) {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.keys(value)
		: []
}

export function validateUiPlan(plan: UiPlan, assets: ApprovedDesignAsset[]) {
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
	for (const component of plan.components) {
		const asset = components.get(component.componentId)
		if (!asset) {
			errors.push(`Unapproved component: ${component.componentId}`)
			continue
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
		if (!tokens.has(token)) errors.push(`Unapproved token: ${token}`)
	}
	return errors
}
