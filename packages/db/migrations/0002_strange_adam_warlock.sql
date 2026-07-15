CREATE TYPE "public"."canvas_edge_kind" AS ENUM('derived_from', 'supports', 'contradicts', 'flows_to', 'implements', 'references');--> statement-breakpoint
CREATE TYPE "public"."canvas_node_kind" AS ENUM('artifact', 'knowledge', 'capture', 'design_asset', 'note', 'frame');--> statement-breakpoint
CREATE TYPE "public"."design_asset_kind" AS ENUM('foundation', 'token', 'primitive', 'component', 'pattern', 'template');--> statement-breakpoint
CREATE TYPE "public"."design_version_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'brief';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'requirement';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'user_flow';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'state_matrix';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'ux_review';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'interface_spec';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'test_case';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'react_prototype';--> statement-breakpoint
ALTER TYPE "public"."connection_provider" ADD VALUE 'github';--> statement-breakpoint
ALTER TYPE "public"."connection_provider" ADD VALUE 'notion';--> statement-breakpoint
ALTER TYPE "public"."connection_provider" ADD VALUE 'google_drive';--> statement-breakpoint
ALTER TYPE "public"."connection_provider" ADD VALUE 'slack';--> statement-breakpoint
ALTER TYPE "public"."connection_provider" ADD VALUE 'mcp';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'url';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'github';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'notion';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'google_drive';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'slack';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'capture';--> statement-breakpoint
CREATE TABLE "artifact_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"generation_input" jsonb,
	"source_refs" jsonb,
	"parent_revision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"node_id" text,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"target_node_id" text NOT NULL,
	"kind" "canvas_edge_kind" DEFAULT 'references' NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"kind" "canvas_node_kind" NOT NULL,
	"artifact_id" text,
	"document_id" text,
	"capture_id" text,
	"design_asset_id" text,
	"label" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"width" integer DEFAULT 320 NOT NULL,
	"height" integer DEFAULT 220 NOT NULL,
	"z_index" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"revision" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text DEFAULT 'Workspace' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"dom_outline" text NOT NULL,
	"screenshot" text,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"kind" "design_asset_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"import_path" text,
	"export_name" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_system_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"design_system_id" text NOT NULL,
	"version" text NOT NULL,
	"status" "design_version_status" DEFAULT 'draft' NOT NULL,
	"manifest" jsonb NOT NULL,
	"bundle_url" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "documents_source_unique";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pinned_design_system_version_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "artifact_revisions" ADD CONSTRAINT "artifact_revisions_artifact_id_ideas_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_comments" ADD CONSTRAINT "canvas_comments_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_comments" ADD CONSTRAINT "canvas_comments_node_id_canvas_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."canvas_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_edges" ADD CONSTRAINT "canvas_edges_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_edges" ADD CONSTRAINT "canvas_edges_source_node_id_canvas_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."canvas_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_edges" ADD CONSTRAINT "canvas_edges_target_node_id_canvas_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."canvas_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_nodes" ADD CONSTRAINT "canvas_nodes_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_nodes" ADD CONSTRAINT "canvas_nodes_artifact_id_ideas_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_nodes" ADD CONSTRAINT "canvas_nodes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_nodes" ADD CONSTRAINT "canvas_nodes_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_nodes" ADD CONSTRAINT "canvas_nodes_design_asset_id_design_assets_id_fk" FOREIGN KEY ("design_asset_id") REFERENCES "public"."design_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_revisions" ADD CONSTRAINT "canvas_revisions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_assets" ADD CONSTRAINT "design_assets_version_id_design_system_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."design_system_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_versions" ADD CONSTRAINT "design_system_versions_design_system_id_design_systems_id_fk" FOREIGN KEY ("design_system_id") REFERENCES "public"."design_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_revisions_artifact_idx" ON "artifact_revisions" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_revisions_version_unique" ON "artifact_revisions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "canvas_comments_canvas_idx" ON "canvas_comments" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "canvas_edges_canvas_idx" ON "canvas_edges" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "canvas_nodes_canvas_idx" ON "canvas_nodes" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "canvas_revisions_canvas_idx" ON "canvas_revisions" USING btree ("canvas_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_revisions_number_unique" ON "canvas_revisions" USING btree ("canvas_id","revision");--> statement-breakpoint
CREATE INDEX "canvases_project_idx" ON "canvases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_project_name_unique" ON "canvases" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "captures_project_idx" ON "captures" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "design_assets_version_idx" ON "design_assets" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "design_assets_kind_idx" ON "design_assets" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "design_versions_system_idx" ON "design_system_versions" USING btree ("design_system_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_versions_system_version_unique" ON "design_system_versions" USING btree ("design_system_id","version");--> statement-breakpoint
CREATE INDEX "design_systems_org_idx" ON "design_systems" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_systems_org_name_unique" ON "design_systems" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_source_unique" ON "documents" USING btree ("org_id","source","source_id");