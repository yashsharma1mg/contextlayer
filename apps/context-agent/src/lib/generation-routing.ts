export const artifactKinds = [
	"brief",
	"requirement",
	"user_flow",
	"state_matrix",
	"ux_review",
	"interface_spec",
	"test_case",
	"react_prototype",
] as const

export type ArtifactKind = (typeof artifactKinds)[number]
export type GenerationKind = ArtifactKind | "auto"

// ponytail: keyword routing; replace with model classification only if real prompts misroute.
export function resolveArtifactKind(
	prompt: string,
	requestedKind: GenerationKind,
): ArtifactKind {
	if (requestedKind !== "auto") return requestedKind
	const intent = prompt.toLowerCase()
	if (
		/spec|information architecture|interaction|interface specification/.test(
			intent,
		)
	)
		return "interface_spec"
	if (/prototype|screen|ui |page|wireframe/.test(intent))
		return "react_prototype"
	if (/flow|journey|funnel|step.by.step/.test(intent)) return "user_flow"
	if (/review|audit|heuristic|usability/.test(intent)) return "ux_review"
	if (/test|qa|acceptance|scenario/.test(intent)) return "test_case"
	if (/state|empty|loading|error|retry|validation/.test(intent)) {
		return "state_matrix"
	}
	if (/requirement|constraint|scope|must/.test(intent)) return "requirement"
	return "brief"
}
