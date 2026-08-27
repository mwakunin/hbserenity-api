-- Double-booking prevention, enforced by the database rather than by a
-- service-layer pre-check. Two concurrent requests can both pass an
-- application-level "is it free?" query and both insert; only a constraint
-- makes the overlap actually impossible.
--
-- drizzle-kit cannot express EXCLUDE constraints, so this migration is
-- hand-written and must be preserved across schema regeneration.

-- btree_gist lets a gist index mix an equality column (property_id, a uuid)
-- with a range column (the daterange) in one exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- '[)' = half-open: check-out day is immediately bookable by the next guest,
-- so back-to-back stays (A checks out 30 Aug, B checks in 30 Aug) do NOT
-- collide. The WHERE clause scopes the rule to bookings that actually hold
-- the dates — cancelled and completed rows are free to overlap.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "property_id" WITH =,
    daterange("check_in", "check_out", '[)') WITH &&
  )
  WHERE (status IN ('pending_payment', 'confirmed'));
--> statement-breakpoint

-- Same rule for host-side blackouts: a property cannot be blacked out twice
-- for overlapping periods.
ALTER TABLE "property_blackouts"
  ADD CONSTRAINT "property_blackouts_no_overlap"
  EXCLUDE USING gist (
    "property_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  );
