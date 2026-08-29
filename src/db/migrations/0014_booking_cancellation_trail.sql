ALTER TABLE "bookings" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Any booking cancelled before this column existed has no timestamp, and the
-- CHECK below rejects exactly that combination — so the constraint would fail
-- to apply on a database that has ever cancelled anything. `updated_at` is
-- when the row last changed, which for a cancelled booking is when it was
-- cancelled: not a guess so much as the only record that was kept.
UPDATE "bookings" SET "cancelled_at" = "updated_at"
 WHERE "status" = 'cancelled' AND "cancelled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_at_matches_status" CHECK (("bookings"."status" = 'cancelled') = ("bookings"."cancelled_at" IS NOT NULL));