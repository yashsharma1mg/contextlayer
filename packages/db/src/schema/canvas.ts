import { sql } from "drizzle-orm"
import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"
import { nanoid } from "nanoid"
import { ideas, projects } from "./ideation"
import { documents } from "./memory"

export const canvasNodeKindEnum = pgEnum("canvas_node_kind", [
	"artifact",
	"knowledge",
	"capture",
	"design_asset",
	"note",
	"frame",
])

export const canvasEdgeKindEnum = pgEnum("canvas_edge_kind", [
	"derived_from",
	"supports",
	"contradicts",
	"flows_to",
	"implements",
	"references",
])

export const designAssetKindEnum = pgEnum("design_asset_kind", [
	"foundation",
	"token",
	"primitive",
	"component",
	"pattern",
	"template",
])

export const designVersionStatusEnum = pgEnum("design_version_status", [
	"draft",
	"active",
	"archived",
])

export const captures = pgTable(
	"captures",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		authorUserId: text("author_user_id").notNull(),
		title: text("title").notNull(),
		url: text("url").notNull(),
		domOutline: text("dom_outline").notNull(),
		screenshot: text("screenshot"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("captures_project_idx").on(table.projectId)],
)

export const captureTokens = pgTable(
	"capture_tokens",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		createdBy: text("created_by").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("capture_tokens_project_idx").on(table.projectId)],
)

export const mcpTokens = pgTable(
	"mcp_tokens",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		userId: text("user_id").notNull(),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		scopes: jsonb("scopes").$type<string[]>().notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("mcp_tokens_org_idx").on(table.orgId)],
)

export const designSystems = pgTable(
	"design_systems",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("design_systems_org_idx").on(table.orgId),
		uniqueIndex("design_systems_org_name_unique").on(table.orgId, table.name),
	],
)

export const designSystemVersions = pgTable(
	"design_system_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		designSystemId: text("design_system_id")
			.notNull()
			.references(() => designSystems.id, { onDelete: "cascade" }),
		version: text("version").notNull(),
		status: designVersionStatusEnum("status").notNull().default("draft"),
		manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
		bundleUrl: text("bundle_url"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("design_versions_system_idx").on(table.designSystemId),
		uniqueIndex("design_versions_system_version_unique").on(
			table.designSystemId,
			table.version,
		),
	],
)

export const designAssets = pgTable(
	"design_assets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		versionId: text("version_id")
			.notNull()
			.references(() => designSystemVersions.id, { onDelete: "cascade" }),
		kind: designAssetKindEnum("kind").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		importPath: text("import_path"),
		exportName: text("export_name"),
		data: jsonb("data").$type<Record<string, unknown>>().notNull(),
	},
	(table) => [
		index("design_assets_version_idx").on(table.versionId),
		index("design_assets_kind_idx").on(table.kind),
	],
)

export const canvases = pgTable(
	"canvases",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull().default("Workspace"),
		revision: integer("revision").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("canvases_project_idx").on(table.projectId),
		uniqueIndex("canvases_project_name_unique").on(table.projectId, table.name),
	],
)

export const canvasNodes = pgTable(
	"canvas_nodes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		canvasId: text("canvas_id")
			.notNull()
			.references(() => canvases.id, { onDelete: "cascade" }),
		kind: canvasNodeKindEnum("kind").notNull(),
		artifactId: text("artifact_id").references(() => ideas.id, {
			onDelete: "cascade",
		}),
		documentId: text("document_id").references(() => documents.id, {
			onDelete: "cascade",
		}),
		captureId: text("capture_id").references(() => captures.id, {
			onDelete: "cascade",
		}),
		designAssetId: text("design_asset_id").references(() => designAssets.id, {
			onDelete: "cascade",
		}),
		label: text("label").notNull(),
		x: integer("x").notNull(),
		y: integer("y").notNull(),
		width: integer("width").notNull().default(320),
		height: integer("height").notNull().default(220),
		zIndex: integer("z_index").notNull().default(0),
		version: integer("version").notNull().default(1),
		data: jsonb("data").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("canvas_nodes_canvas_idx").on(table.canvasId)],
)

export const canvasEdges = pgTable(
	"canvas_edges",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		canvasId: text("canvas_id")
			.notNull()
			.references(() => canvases.id, { onDelete: "cascade" }),
		sourceNodeId: text("source_node_id")
			.notNull()
			.references(() => canvasNodes.id, { onDelete: "cascade" }),
		targetNodeId: text("target_node_id")
			.notNull()
			.references(() => canvasNodes.id, { onDelete: "cascade" }),
		kind: canvasEdgeKindEnum("kind").notNull().default("references"),
		label: text("label"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("canvas_edges_canvas_idx").on(table.canvasId)],
)

export const canvasComments = pgTable(
	"canvas_comments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		canvasId: text("canvas_id")
			.notNull()
			.references(() => canvases.id, { onDelete: "cascade" }),
		nodeId: text("node_id").references(() => canvasNodes.id, {
			onDelete: "cascade",
		}),
		authorUserId: text("author_user_id").notNull(),
		body: text("body").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("canvas_comments_canvas_idx").on(table.canvasId)],
)

export const canvasRevisions = pgTable(
	"canvas_revisions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		canvasId: text("canvas_id")
			.notNull()
			.references(() => canvases.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		authorUserId: text("author_user_id").notNull(),
		reason: text("reason").notNull(),
		snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("canvas_revisions_canvas_idx").on(table.canvasId),
		uniqueIndex("canvas_revisions_number_unique").on(
			table.canvasId,
			table.revision,
		),
	],
)

export const artifactRevisions = pgTable(
	"artifact_revisions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		authorUserId: text("author_user_id").notNull(),
		title: text("title").notNull(),
		content: jsonb("content").$type<Record<string, unknown>>().notNull(),
		generationInput: jsonb("generation_input").$type<Record<string, unknown>>(),
		sourceRefs: jsonb("source_refs").$type<Record<string, unknown>[]>(),
		parentRevisionId: text("parent_revision_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("artifact_revisions_artifact_idx").on(table.artifactId),
		uniqueIndex("artifact_revisions_version_unique").on(
			table.artifactId,
			table.version,
		),
	],
)
