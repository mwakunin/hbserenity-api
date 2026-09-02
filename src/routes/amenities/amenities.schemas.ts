import { z } from "@hono/zod-openapi";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

import { amenities } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectAmenitySchema = toZodV4SchemaTyped(createSelectSchema(amenities));

/**
 * A new entry in the catalogue.
 *
 * `name` is UNIQUE in the database, which is what stops "Wi-Fi" and "Wi-Fi"
 * becoming two pickable things. Trimming here matters for the same reason: a
 * trailing space would slip past the constraint and produce a duplicate the
 * host cannot tell apart.
 *
 * `icon` names a glyph the client renders — it is not a URL, and nothing is
 * fetched from it.
 */
export const insertAmenitySchema = toZodV4SchemaTyped(
  createInsertSchema(amenities, {
    name: field => field.trim().min(1).max(60),
    icon: field => field.trim().min(1).max(60),
  }).omit({ id: true }),
);

export const listAmenitiesResponseSchema = z.object({
  data: z.array(selectAmenitySchema),
});

/**
 * The amenities a listing has, as a complete set rather than a change.
 *
 * A PUT replaces: the body is what the listing ends up with, so unticking a
 * box in a form is expressed by sending the remaining ids, not by a separate
 * delete call. That makes a re-submitted form idempotent, which a
 * POST-one-at-a-time API would not be.
 *
 * Ids are deduplicated by the handler rather than rejected — a form that
 * submits the same box twice means the same thing as one that submits it
 * once, and `property_amenities_pk` would otherwise turn it into a 409.
 */
export const setPropertyAmenitiesSchema = z.object({
  amenityIds: z.array(z.uuid()).max(100).openapi({
    example: ["9b1d1a2c-6f3e-4a5b-8c7d-0e1f2a3b4c5d"],
  }),
});
