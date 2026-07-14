import type { ApprovedDesignAsset, UiPlan } from "./ui-plan"

function identifier(value: string) {
	return value.replace(/[^a-zA-Z0-9_$]/g, "")
}

function attributes(values: Record<string, unknown>) {
	return Object.entries(values)
		.filter(([name]) => /^[a-zA-Z_$][\w$]*$/.test(name))
		.map(([name, value]) => ` ${name}={${JSON.stringify(value)}}`)
		.join("")
}

export function reactSourceFromUiPlan(
	plan: UiPlan,
	assets: ApprovedDesignAsset[],
) {
	const imports = new Map(
		assets.map((asset) => [
			asset.name,
			{
				importPath: asset.data.importPath,
				exportName: asset.data.exportName,
			},
		]),
	)
	const used = plan.components.map((component, index) => {
		const asset = imports.get(component.componentId)
		if (
			!asset ||
			typeof asset.importPath !== "string" ||
			typeof asset.exportName !== "string"
		) {
			throw new Error(`Missing import mapping for ${component.componentId}`)
		}
		return {
			component,
			localName: identifier(component.componentId) || `Component${index + 1}`,
			...asset,
		}
	})
	const importLines = used.map(
		({ exportName, importPath, localName }) =>
			`import { ${exportName} as ${localName} } from ${JSON.stringify(importPath)}`,
	)
	const elements = used.map(
		({ component, localName }) =>
			`      <${localName}${attributes({ ...component.props, ...component.variants })} />`,
	)
	return `"use client"\n\n${[...new Set(importLines)].join("\n")}\n\nexport default function ${identifier(plan.title) || "GeneratedScreen"}() {\n  return (\n    <main>\n      <h1>{${JSON.stringify(plan.title)}}</h1>\n${elements.join("\n")}\n    </main>\n  )\n}\n`
}
