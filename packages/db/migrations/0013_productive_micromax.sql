DROP INDEX "documents_connection_source_unique";--> statement-breakpoint
CREATE TEMP TABLE "_document_dedup" ON COMMIT DROP AS
SELECT "id" AS "duplicate_id", "keep_id"
FROM (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "org_id", "connection_id", "source", "source_id"
			ORDER BY "updated_at" DESC, "id"
		) AS "keep_id"
	FROM "documents"
) ranked
WHERE "id" <> "keep_id";--> statement-breakpoint
INSERT INTO "source_access_grants" ("id", "document_id", "principal_kind", "principal_id", "external_principal_id", "created_at")
SELECT concat('dedup_', md5(random()::text || clock_timestamp()::text)), mapping."keep_id", grants."principal_kind", grants."principal_id", grants."external_principal_id", grants."created_at"
FROM "source_access_grants" grants
INNER JOIN "_document_dedup" mapping ON mapping."duplicate_id" = grants."document_id"
ON CONFLICT ("document_id", "principal_kind", "principal_id") DO NOTHING;--> statement-breakpoint
UPDATE "canvas_nodes" nodes
SET "document_id" = mapping."keep_id"
FROM "_document_dedup" mapping
WHERE nodes."document_id" = mapping."duplicate_id";--> statement-breakpoint
UPDATE "memory_chunks" chunks
SET "document_id" = mapping."keep_id"
FROM "_document_dedup" mapping
WHERE chunks."document_id" = mapping."duplicate_id";--> statement-breakpoint
DELETE FROM "documents" documents
USING "_document_dedup" mapping
WHERE documents."id" = mapping."duplicate_id";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_connection_source_unique" UNIQUE NULLS NOT DISTINCT("org_id","connection_id","source","source_id");
