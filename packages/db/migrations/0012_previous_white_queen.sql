ALTER TABLE "memory_chunks" ALTER COLUMN "embedding" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "provenance" jsonb;