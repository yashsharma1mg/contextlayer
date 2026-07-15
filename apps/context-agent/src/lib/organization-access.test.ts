import { expect, test } from "bun:test"
import { canManageOrganization } from "./organization-access"

test("limits organization management to owners and admins", () => {
	expect(canManageOrganization("owner")).toBe(true)
	expect(canManageOrganization("admin")).toBe(true)
	expect(canManageOrganization("member")).toBe(false)
})
