ALTER TABLE "property_images" ADD COLUMN "file_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "property_images_file_id_idx" ON "property_images" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_images_one_cover_idx" ON "property_images" USING btree ("property_id") WHERE "property_images"."is_cover";