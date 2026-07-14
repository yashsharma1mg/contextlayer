export function isRepositoryPath(path: string) {
	return !path.startsWith("/") && !path.split("/").includes("..")
}
