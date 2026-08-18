import { describe, expect, test } from "bun:test"
import { canAccessScopedResource } from "./access-policy"

const caller = {
	orgId: "org-a",
	userId: "user-a",
	role: "member",
}

describe("canAccessScopedResource", () => {
	test("allows organization context only inside the caller organization", () => {
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "org", ownerUserId: null },
				caller,
			),
		).toBe(true)
		expect(
			canAccessScopedResource(
				{ orgId: "org-b", scope: "org", ownerUserId: null },
				caller,
			),
		).toBe(false)
	})

	test("allows personal context only to its owner", () => {
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "personal", ownerUserId: "user-a" },
				caller,
			),
		).toBe(true)
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "personal", ownerUserId: "user-b" },
				caller,
			),
		).toBe(false)
	})

	test("a personal resource with no owner is reachable by nobody", () => {
		// Guards the fallthrough: with the team branch gone, "not org" means
		// "owner only", so a null owner must not become an accidental allow.
		expect(
			canAccessScopedResource(
				{ orgId: "org-a", scope: "personal", ownerUserId: null },
				caller,
			),
		).toBe(false)
	})

	test("org membership is checked before scope", () => {
		expect(
			canAccessScopedResource(
				{ orgId: "org-b", scope: "personal", ownerUserId: "user-a" },
				caller,
			),
		).toBe(false)
	})
})
