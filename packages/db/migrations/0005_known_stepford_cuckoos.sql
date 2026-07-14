CREATE TABLE "project_share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"created_by" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "project_share_links" ADD CONSTRAINT "project_share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_share_links_project_idx" ON "project_share_links" USING btree ("project_id");