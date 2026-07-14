CREATE TABLE "project_github_settings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"app_root" text DEFAULT '.' NOT NULL,
	"package_manager" text DEFAULT 'bun' NOT NULL,
	"allowed_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"design_system_import" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_github_settings" ADD CONSTRAINT "project_github_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;