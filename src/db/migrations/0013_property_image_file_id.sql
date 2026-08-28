-- Added in three steps rather than as `ADD COLUMN ... NOT NULL`, which
-- Postgres rejects outright on a table that already has rows. There is no
-- endpoint that could have created one, but "the deployment fails" is a poor
-- way to discover otherwise, and a hand-written backfill is cheaper than a
-- blocked release.
--
-- The placeholder is unique per row, which the unique index below requires,
-- and it names no real ImageKit file. That is the honest state: these rows
-- predate the id and their CDN copy cannot be found. Deleting one still works
-- cleanly — ImageKit answers 404 and the handler treats "already gone" as
-- success, so the record can be cleared rather than being stuck forever.
ALTER TABLE "property_images" ADD COLUMN "file_id" text;--> statement-breakpoint
UPDATE "property_images" SET "file_id" = 'legacy-' || "id" WHERE "file_id" IS NULL;--> statement-breakpoint
ALTER TABLE "property_images" ALTER COLUMN "file_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "property_images_file_id_idx" ON "property_images" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_images_one_cover_idx" ON "property_images" USING btree ("property_id") WHERE "property_images"."is_cover";
