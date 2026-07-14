import { sql } from "drizzle-orm"
import {
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core"
import { nanoid } from "nanoid"

/**
 * Visibility works like documents.scope: a project starts personal and can
 * be shared up to team or org. Enforcement lives in application code (WHERE
 * clauses mirroring searchMemories()'s scope pattern) — no per-row ACL
 * table until a real exception case shows up.
 */
export const projectVisibilityEnum = pgEnum("project_visibility", [
	"personal",
	"team",
	"org",
])

export const ideaKindEnum = pgEnum("idea_kind", [
	"concept",
	"ui",
	"brief",
	"requirement",
	"user_flow",
	"state_matrix",
	"ux_review",
	"interface_spec",
	"test_case",
	"react_prototype",
])

export const projects = pgTable(
	"projects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		// Set when visibility is "team" — which team it's shared with.
		teamId: text("team_id"),
		ownerUserId: text("owner_user_id").notNull(),
		name: text("name").notNull(),
		pinnedDesignSystemVersionId: text("pinned_design_system_version_id"),
		visibility: projectVisibilityEnum("visibility")
			.notNull()
			.default("personal"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("projects_org_idx").on(table.orgId),
		index("projects_owner_idx").on(table.ownerUserId),
	],
)

export const projectShareLinks = pgTable(
	"project_share_links",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		createdBy: text("created_by").notNull(),
		// Share tokens are returned once and never stored in recoverable form.
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("project_share_links_project_idx").on(table.projectId)],
)

export const projectGitHubSettings = pgTable("project_github_settings", {
	projectId: text("project_id")
		.primaryKey()
		.references(() => projects.id, { onDelete: "cascade" }),
	repository: text("repository").notNull(),
	baseBranch: text("base_branch").notNull().default("main"),
	appRoot: text("app_root").notNull().default("."),
	packageManager: text("package_manager").notNull().default("bun"),
	allowedPaths: jsonb("allowed_paths").$type<string[]>().notNull().default([]),
	designSystemImport: text("design_system_import"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.default(sql`now()`),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.default(sql`now()`),
})

export const ideas = pgTable(
	"ideas",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		authorUserId: text("author_user_id").notNull(),
		kind: ideaKindEnum("kind").notNull(),
		title: text("title").notNull(),
		// Markdown for "concept" ideas; empty for pure "ui" ideas.
		body: text("body"),
		// Single-file HTML+Tailwind artifact for "ui" ideas.
		generatedCode: text("generated_code"),
		// The prompt that produced this idea, kept for iteration/regeneration.
		prompt: text("prompt").notNull(),
		// Which memory chunks grounded the generation: [{documentId, title, url}]
		sourceRefs:
			jsonb("source_refs").$type<
				{ documentId: string; title: string; url: string | null }[]
			>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("ideas_project_idx").on(table.projectId)],
)

export const ideaComments = pgTable(
	"idea_comments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		authorUserId: text("author_user_id").notNull(),
		body: text("body").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("idea_comments_idea_idx").on(table.ideaId)],
)
