ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint

-- Better Auth >= 1.7 scopes account identity by issuer. Added in three steps
-- rather than as NOT NULL directly, so it also works where account rows
-- already exist: a bare ADD COLUMN ... NOT NULL would fail on them.
--
-- Backfilled with the synthetic value Better Auth itself generates for a
-- provider with no issuer of its own — `local:<providerId>`.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint
UPDATE "account" SET "issuer" = 'local:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
