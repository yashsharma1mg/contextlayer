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
import { designSystems } from "./canvas"
import { ideas, projects } from "./ideation"
import { connections, documents } from "./memory"

export const projectRoleEnum = pgEnum("project_role", [
	"owner",
	"editor",
	"viewer",
])

export const projectMembers = pgTable(
	"project_members",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		role: projectRoleEnum("role").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		uniqueIndex("project_members_project_user_unique").on(
			table.projectId,
			table.userId,
		),
		index("project_members_user_idx").on(table.userId),
	],
)

export const sourcePrincipalKindEnum = pgEnum("source_principal_kind", [
	"organization",
	"team",
	"user",
])

export const sourceAccessGrants = pgTable(
	"source_access_grants",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		documentId: text("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		principalKind: sourcePrincipalKindEnum("principal_kind").notNull(),
		principalId: text("principal_id").notNull(),
		externalPrincipalId: text("external_principal_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		uniqueIndex("source_access_grants_unique").on(
			table.documentId,
			table.principalKind,
			table.principalId,
		),
		index("source_access_grants_principal_idx").on(
			table.principalKind,
			table.principalId,
		),
	],
)

export const storedObjectKindEnum = pgEnum("stored_object_kind", [
	"source_original",
	"capture_dom",
	"capture_screenshot",
	"media_keyframe",
	"design_bundle",
	"generated_bundle",
	"backup",
])

export const storedObjects = pgTable(
	"stored_objects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		kind: storedObjectKindEnum("kind").notNull(),
		contentHash: text("content_hash").notNull(),
		storageKey: text("storage_key").notNull(),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		encryption: jsonb("encryption").$type<{
			algorithm: "aes-256-gcm"
			iv: string
			tag: string
		}>(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [
		uniqueIndex("stored_objects_org_kind_hash_unique").on(
			table.orgId,
			table.kind,
			table.contentHash,
		),
		index("stored_objects_org_idx").on(table.orgId),
	],
)

export const backgroundJobStatusEnum = pgEnum("background_job_status", [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
])

export const backgroundJobs = pgTable(
	"background_jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdBy: text("created_by").notNull(),
		type: text("type").notNull(),
		status: backgroundJobStatusEnum("status").notNull().default("queued"),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		result: jsonb("result").$type<Record<string, unknown>>(),
		progress: integer("progress").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(3),
		idempotencyKey: text("idempotency_key"),
		runAfter: timestamp("run_after", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		leaseUntil: timestamp("lease_until", { withTimezone: true }),
		workerId: text("worker_id"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("background_jobs_claim_idx").on(
			table.status,
			table.runAfter,
			table.leaseUntil,
		),
		index("background_jobs_org_idx").on(table.orgId, table.createdAt),
		uniqueIndex("background_jobs_idempotency_unique").on(
			table.orgId,
			table.type,
			table.idempotencyKey,
		),
	],
)

export const connectorCursors = pgTable("connector_cursors", {
	connectionId: text("connection_id")
		.primaryKey()
		.references(() => connections.id, { onDelete: "cascade" }),
	cursor: text("cursor"),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
	lastError: text("last_error"),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.default(sql`now()`),
})

export const providerConsents = pgTable(
	"provider_consents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		orgId: text("org_id").notNull(),
		userId: text("user_id").notNull(),
		provider: text("provider").notNull(),
		purposes: jsonb("purposes").$type<string[]>().notNull(),
		grantedAt: timestamp("granted_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("provider_consents_unique").on(
			table.orgId,
			table.userId,
			table.provider,
		),
	],
)

export const designImportRuns = pgTable(
	"design_import_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		designSystemId: text("design_system_id")
			.notNull()
			.references(() => designSystems.id, { onDelete: "cascade" }),
		createdBy: text("created_by").notNull(),
		sourceType: text("source_type").notNull(),
		source: jsonb("source").$type<Record<string, unknown>>().notNull(),
		status: backgroundJobStatusEnum("status").notNull().default("queued"),
		candidateManifest:
			jsonb("candidate_manifest").$type<Record<string, unknown>>(),
		issues: jsonb("issues")
			.$type<Record<string, unknown>[]>()
			.notNull()
			.default([]),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [index("design_import_runs_system_idx").on(table.designSystemId)],
)

export const generatedFileSets = pgTable(
	"generated_file_sets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		targetFramework: text("target_framework").notNull(),
		files: jsonb("files")
			.$type<{ path: string; content: string }[]>()
			.notNull(),
		validation: jsonb("validation").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	},
	(table) => [index("generated_file_sets_artifact_idx").on(table.artifactId)],
)

export const publicationAudits = pgTable(
	"publication_audits",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		approvedBy: text("approved_by").notNull(),
		repository: text("repository").notNull(),
		branch: text("branch").notNull(),
		status: text("status").notNull(),
		validation: jsonb("validation").$type<Record<string, unknown>>().notNull(),
		pullRequestUrl: text("pull_request_url"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [index("publication_audits_project_idx").on(table.projectId)],
)
