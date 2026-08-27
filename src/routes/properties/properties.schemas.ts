import { z } from "@hono/zod-openapi";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z as z4 } from "zod/v4";

import { properties, propertyImages } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

/**
 * M-Pesa transacts whole shillings, and the database enforces the same rule
 * with a CHECK constraint. Validating here too turns what would be a 500 from
 * a constraint violation into a readable 422.
 */
function wholeShillings(field: z.ZodNumber) {
  return field.int().nonnegative().refine(
    n => n % 100 === 0,
    "Amount must be a whole number of shillings (divisible by 100)",
  );
}

// Kept unwrapped so it can still be `.extend()`ed below — toZodV4SchemaTyped
// casts away the object shape that composition needs.
const rawSelectProperty = createSelectSchema(properties);
const rawSelectPropertyImage = createSelectSchema(propertyImages);

export const selectPropertySchema = toZodV4SchemaTyped(rawSelectProperty);

export const insertPropertySchema = toZodV4SchemaTyped(
  createInsertSchema(properties, {
    title: field => field.min(3).max(200),
    description: field => field.min(10).max(5000),
    county: field => field.min(1).max(100),
    town: field => field.min(1).max(100),
    maxGuests: field => field.int().positive().max(100),
    bedrooms: field => field.int().nonnegative().max(50),
    bathrooms: field => field.int().nonnegative().max(50),
    beds: field => field.int().nonnegative().max(100),
    latitude: field => field.min(-90).max(90),
    longitude: field => field.min(-180).max(180),
    pricePerNightCents: wholeShillings,
    cleaningFeeCents: wholeShillings,
  }).omit({
    id: true,
    // Derived from the session, never from the client.
    hostId: true,
    createdAt: true,
    updatedAt: true,
  }),
);

// @ts-expect-error partial exists on the zod v4 type
export const patchPropertySchema = insertPropertySchema.partial();

export const selectPropertyImageSchema = toZodV4SchemaTyped(rawSelectPropertyImage);

export const insertPropertyImageSchema = toZodV4SchemaTyped(
  createInsertSchema(propertyImages, {
    url: field => field.url(),
    order: field => field.int().nonnegative(),
  }).omit({
    id: true,
    propertyId: true,
    createdAt: true,
  }),
);

/** Public list filters. Everything optional — an unfiltered list is valid. */
export const listPropertiesQuerySchema = z.object({
  county: z.string().min(1).optional().openapi({ example: "Kwale" }),
  town: z.string().min(1).optional().openapi({ example: "Diani" }),
  propertyType: z
    .enum(["apartment", "house", "villa", "cottage", "studio", "guesthouse"])
    .optional(),
  minGuests: z.coerce.number().int().positive().optional().openapi({ example: 4 }),
  maxPriceCents: z.coerce.number().int().nonnegative().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const propertyWithImagesSchema = toZodV4SchemaTyped(
  rawSelectProperty.extend({
    images: z4.array(rawSelectPropertyImage),
    amenities: z4.array(z4.object({
      id: z4.string(),
      name: z4.string(),
      icon: z4.string().nullable(),
    })),
  }),
);

export const listPropertiesResponseSchema = z.object({
  data: z.array(selectPropertySchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});
