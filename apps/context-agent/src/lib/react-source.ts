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

function pathSegment(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "screen"
	)
}

function sourceForComponents(
	name: string,
	components: UiPlan["components"],
	assets: ApprovedDesignAsset[],
) {
	return reactSourceFromUiPlan(
		{
			title: name,
			summary: name,
			manifestVersionId: "generated",
			targetFramework: "vite",
			screens: [{ name, purpose: name, route: "/", states: ["default"] }],
			navigation: [],
			components,
			tokens: [],
			citations: [],
			fileStructure: ["src/App.tsx"],
		},
		assets,
	)
}

export function reactFilesFromUiPlan(
	plan: UiPlan,
	assets: ApprovedDesignAsset[],
) {
	if (plan.targetFramework === "nextjs") {
		return plan.screens.map((screen) => ({
			path: `app/${screen.route === "/" ? "" : `${pathSegment(screen.route)}/`}page.tsx`,
			content: sourceForComponents(
				screen.name,
				plan.components.filter(
					(component) => !component.screen || component.screen === screen.name,
				),
				assets,
			),
		}))
	}
	const screens = plan.screens.map((screen) => {
		const componentName = `${identifier(screen.name) || "Screen"}Screen`
		return {
			path: `src/screens/${componentName}.tsx`,
			componentName,
			content: sourceForComponents(
				screen.name,
				plan.components.filter(
					(component) => !component.screen || component.screen === screen.name,
				),
				assets,
			).replace(
				/export default function [A-Za-z0-9_$]+/,
				`export default function ${componentName}`,
			),
		}
	})
	const app = screens
		.map(
			(screen) =>
				`import ${screen.componentName} from "./screens/${screen.componentName}"`,
		)
		.join("\n")
	return [
		...screens.map(({ path, content }) => ({ path, content })),
		{
			path: "src/App.tsx",
			content: `${app}\n\nexport default function App() {\n  return (\n    <>\n${screens.map((screen) => `      <${screen.componentName} />`).join("\n")}\n    </>\n  )\n}\n`,
		},
	]
}
