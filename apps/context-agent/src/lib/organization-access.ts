export function canManageOrganization(role: string) {
	return role === "owner" || role === "admin"
}
