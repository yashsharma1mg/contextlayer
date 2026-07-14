import { expect, test } from "bun:test"
import { resolveArtifactKind } from "./generation-routing"

test("routes common product prompts without a model request", () => {
	expect(resolveArtifactKind("Map the onboarding journey", "auto")).toBe(
		"user_flow",
	)
	expect(
		resolveArtifactKind("Design the billing settings screen", "auto"),
	).toBe("react_prototype")
	expect(
		resolveArtifactKind(
			"Create an interface specification for settings",
			"auto",
		),
	).toBe("interface_spec")
	expect(resolveArtifactKind("Summarize the launch context", "auto")).toBe(
		"brief",
	)
})
