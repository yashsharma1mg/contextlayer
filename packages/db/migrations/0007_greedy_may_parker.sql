CREATE TYPE "public"."background_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."source_principal_kind" AS ENUM('organization', 'team', 'user');--> statement-breakpoint
CREATE TYPE "public"."stored_object_kind" AS ENUM('source_original', 'capture_dom', 'capture_screenshot', 'media_keyframe', 'design_bundle', 'generated_bundle', 'backup');--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"created_by" text NOT NULL,
	"type" text NOT NULL,
	"status" "background_job_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"idempotency_key" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_cursors" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"design_system_id" text NOT NULL,
	"created_by" text NOT NULL,
	"source_type" text NOT NULL,
	"source" jsonb NOT NULL,
	"status" "background_job_status" DEFAULT 'queued' NOT NULL,
	"candidate_manifest" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generated_file_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"target_framework" text NOT NULL,
	"files" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "project_role" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"purposes" jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "publication_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"approved_by" text NOT NULL,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"status" text NOT NULL,
	"validation" jsonb NOT NULL,
	"pull_request_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"principal_kind" "source_principal_kind" NOT NULL,
	"principal_id" text NOT NULL,
	"external_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "stored_object_kind" NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"encryption" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "project_members" ("id", "project_id", "user_id", "role", "created_by")
SELECT md5("id" || ':' || "owner_user_id"), "id", "owner_user_id", 'owner', "owner_user_id"
FROM "projects";
--> statement-breakpoint
INSERT INTO "source_access_grants" ("id", "document_id", "principal_kind", "principal_id")
SELECT
	md5("id" || ':' || "scope"::text || ':' || coalesce("team_id", "owner_user_id", "org_id")),
	"id",
	CASE
		WHEN "scope" = 'team' THEN 'team'::"source_principal_kind"
		WHEN "scope" = 'personal' THEN 'user'::"source_principal_kind"
		ELSE 'organization'::"source_principal_kind"
	END,
	coalesce("team_id", "owner_user_id", "org_id")
FROM "documents";
--> statement-breakpoint
DROP INDEX "documents_org_source_unique";--> statement-breakpoint
ALTER TABLE "canvas_comments" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canvas_comments" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_cursors" ADD CONSTRAINT "connector_cursors_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_import_runs" ADD CONSTRAINT "design_import_runs_design_system_id_design_systems_id_fk" FOREIGN KEY ("design_system_id") REFERENCES "public"."design_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_file_sets" ADD CONSTRAINT "generated_file_sets_artifact_id_ideas_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_audits" ADD CONSTRAINT "publication_audits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_audits" ADD CONSTRAINT "publication_audits_artifact_id_ideas_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_access_grants" ADD CONSTRAINT "source_access_grants_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","run_after","lease_until");--> statement-breakpoint
CREATE INDEX "background_jobs_org_idx" ON "background_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_unique" ON "background_jobs" USING btree ("org_id","type","idempotency_key");--> statement-breakpoint
CREATE INDEX "design_import_runs_system_idx" ON "design_import_runs" USING btree ("design_system_id");--> statement-breakpoint
CREATE INDEX "generated_file_sets_artifact_idx" ON "generated_file_sets" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_project_user_unique" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_consents_unique" ON "provider_consents" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "publication_audits_project_idx" ON "publication_audits" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_access_grants_unique" ON "source_access_grants" USING btree ("document_id","principal_kind","principal_id");--> statement-breakpoint
CREATE INDEX "source_access_grants_principal_idx" ON "source_access_grants" USING btree ("principal_kind","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_objects_org_hash_unique" ON "stored_objects" USING btree ("org_id","content_hash");--> statement-breakpoint
CREATE INDEX "stored_objects_org_idx" ON "stored_objects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_connection_source_unique" ON "documents" USING btree ("connection_id","source","source_id");
