import { describe, expect, test } from "bun:test"
import { canAccessScopedResource } from "./access-policy"

const caller = {
	orgId: "org-a",
	userId: "user-a",
	teamIds: ["team-a"],
	role: "member",
}

describe("canAccessScopedResource", () => {
	test("allows organization context only inside the caller organization", () => {
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "org", teamId: null, ownerUserId: null },
				caller,
			),
		).toBe(true)
		expect(
			canAccessScopedResource(
				{ orgId: "org-b", scope: "org", teamId: null, ownerUserId: null },
				caller,
			),
		).toBe(false)
	})

	test("allows team context only to members of that team", () => {
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "team", teamId: "team-a", ownerUserId: null },
				caller,
			),
		).toBe(true)
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "team", teamId: "team-b", ownerUserId: null },
				caller,
			),
		).toBe(false)
	})

	test("allows personal context only to its owner", () => {
		expect(
			canAccessScopedResource(
				{
					orgId: "org-a",
					scope: "personal",
					teamId: null,
					ownerUserId: "user-a",
				},
				caller,
			),
		).toBe(true)
		expect(
			canAccessScopedResource(
				{
					orgId: "org-a",
					scope: "personal",
					teamId: null,
					ownerUserId: "user-b",
				},
				caller,
			),
		).toBe(false)
	})
})
