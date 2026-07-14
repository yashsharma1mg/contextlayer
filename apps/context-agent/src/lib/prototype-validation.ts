export type GeneratedFile = { path: string; content: string }

export function validateGeneratedFiles(
	files: GeneratedFile[],
	allowedImports: string[],
) {
	const errors: string[] = []
	const paths = new Set<string>()
	const allowed = new Set(allowedImports)
	for (const file of files) {
		if (
			file.path.startsWith("/") ||
			file.path.split("/").includes("..") ||
			!/^[-\w./]+\.(?:ts|tsx|css|json)$/.test(file.path)
		) {
			errors.push(`Unsafe generated path: ${file.path}`)
			continue
		}
		if (paths.has(file.path))
			errors.push(`Duplicate generated path: ${file.path}`)
		paths.add(file.path)
		if (Buffer.byteLength(file.content) > 500_000) {
			errors.push(`Generated file is too large: ${file.path}`)
		}
		if (
			/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|window\.open)\b/.test(
				file.content,
			)
		) {
			errors.push(`Forbidden browser capability in ${file.path}`)
		}
		if (
			/\.css$/.test(file.path) &&
			/@import|url\(\s*["']?https?:/i.test(file.content)
		) {
			errors.push(`Remote CSS import in ${file.path}`)
		}
		if (/\.[jt]sx?$/.test(file.path)) {
			try {
				const transpiler = new Bun.Transpiler({
					loader: file.path.endsWith("x") ? "tsx" : "ts",
				})
				for (const imported of transpiler.scan(file.content).imports) {
					if (!imported.path.startsWith(".") && !allowed.has(imported.path)) {
						errors.push(`Unapproved import ${imported.path} in ${file.path}`)
					}
				}
				transpiler.transformSync(file.content)
			} catch (error) {
				errors.push(
					`Compilation failed for ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}
	return errors
}
