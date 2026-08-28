ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint

-- Better Auth >= 1.7 scopes account identity by issuer. Added in steps rather
-- than as NOT NULL directly, so it also works where account rows already
-- exist: a bare ADD COLUMN ... NOT NULL would fail on them.
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;--> statement-breakpoint

-- The issuer is NOT a uniform function of provider_id, and getting it wrong is
-- worse than failing: a row backfilled to a value Better Auth never looks up
-- is invisible, so that user's sign-in silently stops finding their account.
--
--   credential -> local:credential          (createLocalAccountIssuer)
--   google     -> https://accounts.google.com   (the provider's real OIDC
--                                                issuer, not a synthetic one)
--
-- Providers that declare no issuer of their own would use
-- `local:oauth:<providerId>`, but guessing which ones those are is exactly the
-- mistake above. Only the two mappings verified against this Better Auth
-- version are applied; anything else stops the migration with something
-- actionable.
DO $$
DECLARE
  unmapped text;
BEGIN
  SELECT string_agg(DISTINCT "provider_id", ', ')
    INTO unmapped
  FROM "account"
  WHERE "issuer" IS NULL
    AND "provider_id" NOT IN ('credential', 'google');

  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot backfill account.issuer: no verified mapping for provider(s) %. Look up what this Better Auth version writes for them (a real OIDC issuer, or local:oauth:<providerId>) and extend this migration before re-running.',
      unmapped;
  END IF;
END $$;
--> statement-breakpoint

UPDATE "account"
SET "issuer" = CASE "provider_id"
  WHEN 'credential' THEN 'local:credential'
  WHEN 'google' THEN 'https://accounts.google.com'
END
WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
