-- (issuer, account_id) is the pair Better Auth treats as an account's stable
-- identity. Nothing enforced it before, so a database that predates this can
-- hold duplicates — and 0006 backfills them to identical values, which would
-- make a bare CREATE UNIQUE INDEX abort the whole deployment with a cryptic
-- constraint error.
--
-- Two very different situations hide behind "duplicate", so they are handled
-- differently rather than both being deleted or both aborting.

-- 1. Same identity, same user: genuinely redundant rows, one is a leftover.
--    Keep the most recently updated and drop the rest. No login is lost,
--    because the surviving row belongs to the same person.
DELETE FROM "account" a
USING "account" b
WHERE a."issuer" = b."issuer"
  AND a."account_id" = b."account_id"
  AND a."user_id" = b."user_id"
  AND (a."updated_at", a."id") < (b."updated_at", b."id");
--> statement-breakpoint

-- 2. Same identity, DIFFERENT users: one provider identity claimed by two
--    accounts. Deleting either would silently remove somebody's ability to
--    sign in, so stop with something a human can act on instead.
DO $$
DECLARE
  conflict_count integer;
  sample text;
BEGIN
  SELECT count(*), min("issuer" || ' / ' || "account_id")
    INTO conflict_count, sample
  FROM (
    SELECT "issuer", "account_id"
    FROM "account"
    GROUP BY "issuer", "account_id"
    HAVING count(DISTINCT "user_id") > 1
  ) AS conflicts;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add the account identity constraint: % provider identit(ies) are claimed by more than one user (e.g. %). Decide which account owns each one and remove the others, then re-run this migration.',
      conflict_count, sample;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_account_id_idx"
  ON "account" USING btree ("issuer", "account_id");
