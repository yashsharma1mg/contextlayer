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
import { vector } from "./vector-type"

/**
 * IDs here are `text` to match Better Auth's default id shape (nanoid-style),
 * since organization.id / team.id / user.id are the FK targets once
 * schema/auth.ts is generated via `bunx @better-auth/cli generate`.
 */

export const documentSourceEnum = pgEnum("document_source", [
	"confluence",
	"figma",
	"manual",
])

export const containerScopeEnum = pgEnum("container_scope", [
	"org",
	"team",
	"personal",
])

/**
 * One row per ingested unit of content (a Confluence page, a Figma file's
 * comment thread, etc). `orgId` is always set; exactly one of `teamId` /
 * `ownerUserId` is set depending on `scope` ("org" scope has neither).
 * Read visibility is scope-based (see routes: org-wide / team-member /
 * owner-only) — no separate per-document ACL table until an actual
 * exception case (share doc X outside its default scope) shows up.
 */
export const documents = pgTable(
	"documents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		teamId: text("team_id"),
		ownerUserId: text("owner_user_id"),
		scope: containerScopeEnum("scope").notNull(),
		source: documentSourceEnum("source").notNull(),
		// External id from the source system (Confluence page id, Figma file key).
		sourceId: text("source_id").notNull(),
		title: text("title").notNull(),
		url: text("url"),
		// Raw content as fetched (ADF JSON for Confluence, comment/description text for Figma).
		rawContent: text("raw_content").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		// High-watermark for CQL polling (Confluence has no webhook support for OAuth apps).
		sourceUpdatedAt: timestamp("source_updated_at", {
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("documents_org_idx").on(table.orgId),
		index("documents_team_idx").on(table.teamId),
		index("documents_owner_idx").on(table.ownerUserId),
		uniqueIndex("documents_source_unique").on(table.source, table.sourceId),
	],
)

/**
 * Chunked + embedded pieces of a document, used for semantic search.
 * Dimension 1024 matches NVIDIA nv-embedqa-e5-v5.
 */
export const memoryChunks = pgTable(
	"memory_chunks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		documentId: text("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		chunkIndex: integer("chunk_index").notNull(),
		content: text("content").notNull(),
		embedding: vector(1024)("embedding").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("memory_chunks_document_idx").on(table.documentId)],
)

export const connectionProviderEnum = pgEnum("connection_provider", [
	"confluence",
	"figma",
])

/**
 * OAuth connection to an external source, one per org per provider.
 * Confluence and Figma connections are the same shape (org, tokens); the
 * few provider-specific fields (Confluence's cloudId/siteUrl/lastPolledAt)
 * live in `metadata` instead of duplicating the whole table per provider.
 */
export const connections = pgTable(
	"connections",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		provider: connectionProviderEnum("provider").notNull(),
		providerAccountId: text("provider_account_id").notNull(),
		accessToken: text("access_token").notNull(),
		refreshToken: text("refresh_token").notNull(),
		tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		index("connections_org_idx").on(table.orgId),
		uniqueIndex("connections_org_provider_unique").on(
			table.orgId,
			table.provider,
		),
	],
)
