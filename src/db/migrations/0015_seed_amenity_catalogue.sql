-- The amenities table has been in the schema since 0000 and empty ever since:
-- nothing could write to it, so `GET /properties/{id}` has always returned an
-- empty amenity list. An admin can now add entries through POST /amenities,
-- but a picker that starts with nothing in it is not a usable editor, so seed
-- the vocabulary a coastal Kenyan listing actually advertises.
--
-- Names are what guests read and what the UNIQUE constraint dedupes on. Icons
-- name a glyph for the client to render (lucide-react's naming) and are
-- advisory — nothing breaks if a client does not recognise one.
--
-- ON CONFLICT so re-running against a database that already has these is a
-- no-op rather than a failure, and so a host who added "Wi-Fi" by hand before
-- this ran keeps their row rather than colliding with it.
INSERT INTO "amenities" ("name", "icon") VALUES
  ('Wi-Fi', 'wifi'),
  ('Air conditioning', 'air-vent'),
  ('Ceiling fan', 'fan'),
  ('Swimming pool', 'waves'),
  ('Beach access', 'palmtree'),
  ('Free parking', 'car'),
  ('Kitchen', 'utensils-crossed'),
  ('Washing machine', 'washing-machine'),
  ('TV', 'tv'),
  ('Hot water', 'shower-head'),
  ('Backup generator', 'zap'),
  ('Borehole water', 'droplet'),
  ('Security', 'shield-check'),
  ('Garden', 'trees'),
  ('Barbecue grill', 'flame'),
  ('Workspace', 'laptop'),
  ('Gym', 'dumbbell'),
  ('Housekeeping', 'sparkles'),
  ('Pets allowed', 'paw-print'),
  ('Family friendly', 'baby')
ON CONFLICT ("name") DO NOTHING;
