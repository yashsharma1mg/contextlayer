-- Teams are removed. Existing 'team' values must be rewritten BEFORE the enum
-- types are recreated without them, otherwise every cast below fails.
--
-- projects: team -> personal. Never widen access silently. Rows in
-- project_members are untouched, so anyone explicitly added to the project
-- keeps their access; only the implicit "whole team can see it" grant goes.
UPDATE "projects" SET "visibility" = 'personal' WHERE "visibility" = 'team';--> statement-breakpoint
-- documents: team -> org, paired with an organization grant below. Read access
-- is decided by source_access_grants, not by this column, so dropping the team
-- grant without a replacement would orphan the document instead of just
-- narrowing it.
UPDATE "documents" SET "scope" = 'org' WHERE "scope" = 'team';--> statement-breakpoint
INSERT INTO "source_access_grants" ("id", "document_id", "principal_kind", "principal_id")
SELECT
	substr(md5(random()::text || g."document_id"), 1, 21),
	g."document_id",
	'organization',
	d."org_id"
FROM "source_access_grants" g
JOIN "documents" d ON d."id" = g."document_id"
WHERE g."principal_kind" = 'team'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "source_access_grants" WHERE "principal_kind" = 'team';--> statement-breakpoint
ALTER TABLE "team" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "team" CASCADE;--> statement-breakpoint
DROP TABLE "team_member" CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "visibility" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "visibility" SET DEFAULT 'personal'::text;--> statement-breakpoint
DROP TYPE "public"."project_visibility";--> statement-breakpoint
CREATE TYPE "public"."project_visibility" AS ENUM('personal', 'org');--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "visibility" SET DEFAULT 'personal'::"public"."project_visibility";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "visibility" SET DATA TYPE "public"."project_visibility" USING "visibility"::"public"."project_visibility";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "scope" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."container_scope";--> statement-breakpoint
CREATE TYPE "public"."container_scope" AS ENUM('org', 'personal');--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "scope" SET DATA TYPE "public"."container_scope" USING "scope"::"public"."container_scope";--> statement-breakpoint
ALTER TABLE "source_access_grants" ALTER COLUMN "principal_kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."source_principal_kind";--> statement-breakpoint
CREATE TYPE "public"."source_principal_kind" AS ENUM('organization', 'user');--> statement-breakpoint
ALTER TABLE "source_access_grants" ALTER COLUMN "principal_kind" SET DATA TYPE "public"."source_principal_kind" USING "principal_kind"::"public"."source_principal_kind";--> statement-breakpoint
DROP INDEX "documents_team_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_team_id";