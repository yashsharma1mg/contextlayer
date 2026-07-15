import { posix } from "node:path"

export function isRepositoryPath(path: string) {
	return (
		!!path &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.split("/").includes("..")
	)
}

export function isAllowedRepositoryFile(
	path: string,
	appRoot: string,
	allowedPaths: string[],
) {
	if (
		!isRepositoryPath(path) ||
		!isRepositoryPath(appRoot) ||
		allowedPaths.some((root) => !isRepositoryPath(root))
	) {
		return false
	}
	const target = posix.normalize(posix.join(appRoot, path))
	if (!isRepositoryPath(target)) return false
	const roots = allowedPaths.length ? allowedPaths : [appRoot]
	return roots.some((root) => {
		const normalized = posix.normalize(root)
		return (
			normalized === "." ||
			target === normalized ||
			target.startsWith(`${normalized}/`)
		)
	})
}
