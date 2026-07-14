DROP INDEX "stored_objects_org_hash_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "stored_objects_org_kind_hash_unique" ON "stored_objects" USING btree ("org_id","kind","content_hash");