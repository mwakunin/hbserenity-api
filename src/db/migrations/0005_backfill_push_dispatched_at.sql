-- Any payment row that predates push_dispatched_at has a NULL marker, which
-- releaseStaleAttempt would read as "no push was ever dispatched" and release
-- — potentially freeing a retry to add a second live PIN prompt.
--
-- No such row can exist today (the M-Pesa code ships in the same change that
-- added the column), but assuming a push DID happen is the safe reading, so
-- backfill rather than rely on that staying true. Only pending rows matter;
-- settled ones are never released.
UPDATE "payments"
SET "push_dispatched_at" = "created_at"
WHERE "status" = 'pending'
  AND "push_dispatched_at" IS NULL;
