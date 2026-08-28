-- Two overrides covering the same night would make that night's price
-- ambiguous, and whichever the query happened to return first would win.
-- Same EXCLUDE treatment as bookings and blackouts; drizzle-kit cannot
-- express it, so this migration is hand-written and must be preserved.
ALTER TABLE "property_rate_overrides"
  ADD CONSTRAINT "property_rate_overrides_no_overlap"
  EXCLUDE USING gist (
    "property_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  );
