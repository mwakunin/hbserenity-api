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

/**
 * `bedrooms` counts separate enclosed sleeping rooms, so 0 is valid — a studio
 * or bedsitter. `bathrooms` may be 0 where ablutions are shared. `beds` is
 * places to sleep and is never 0: a listing that sleeps nobody isn't bookable.
 *
 * Kept unwrapped so both the refined insert schema and the partial patch
 * schema can be derived from it — `.refine()` returns a type that no longer
 * offers `.partial()`.
 */
const rawInsertProperty = createInsertSchema(properties, {
  title: field => field.min(3).max(200),
  description: field => field.min(10).max(5000),
  county: field => field.min(1).max(100),
  town: field => field.min(1).max(100),
  maxGuests: field => field.int().positive().max(100),
  bedrooms: field => field.int().nonnegative().max(50),
  bathrooms: field => field.int().nonnegative().max(50),
  beds: field => field.int().min(1).max(100),
  latitude: field => field.min(-90).max(90),
  longitude: field => field.min(-180).max(180),
  pricePerNightCents: wholeShillings,
  cleaningFeeCents: wholeShillings,
  weekendPriceCents: wholeShillings,
}).omit({
  id: true,
  // Derived from the session, never from the client.
  hostId: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPropertySchema = toZodV4SchemaTyped(
  // Mirrors the properties_bedrooms_match_type CHECK so the mismatch is a
  // readable 422 rather than a constraint violation surfacing as a 500.
  rawInsertProperty.refine(
    p => (p.propertyType === "studio" ? p.bedrooms === 0 : p.bedrooms >= 1),
    {
      path: ["bedrooms"],
      message:
        "A studio must have 0 bedrooms; every other property type must have "
        + "at least 1. Count enclosed sleeping rooms, not beds.",
    },
  ),
);

// Partial: a patch can't be checked across fields without the existing row,
// so the DB CHECK is the backstop and the handler maps it to a 422.
export const patchPropertySchema = toZodV4SchemaTyped(rawInsertProperty.partial());

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
  /**
   * Admin only, and ignored for everyone else.
   *
   * The public browse endpoint must never expose a draft, so "active" stays
   * an unconditional floor for a non-admin rather than something a role check
   * has to get right on every path. An admin may widen it; nobody else can.
   */
  status: z
    .enum(["draft", "active", "inactive", "all"])
    .optional()
    .openapi({ example: "all" }),
  /**
   * Only listings free for the whole stay.
   *
   * Half-open like every other range here: a listing whose booking ends on
   * `checkIn` is free, and one whose booking starts on `checkOut` is too.
   * Without these a search bar carrying dates cannot filter on them, and the
   * alternative is an availability request per listing on the page.
   */
  checkIn: z.iso.date().optional().openapi({ example: "2026-09-10" }),
  checkOut: z.iso.date().optional().openapi({ example: "2026-09-14" }),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
}).refine(
  // One date alone cannot answer "is this free?", and silently ignoring the
  // other would show a guest listings that are taken on dates they asked for.
  q => (q.checkIn === undefined) === (q.checkOut === undefined),
  { message: "Provide both checkIn and checkOut, or neither", path: ["checkOut"] },
).refine(
  q => q.checkIn === undefined || q.checkOut === undefined || q.checkOut > q.checkIn,
  { message: "checkOut must be after checkIn", path: ["checkOut"] },
);

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

/**
 * A listing as it appears in a list, plus its cover photo.
 *
 * Only the cover, not the whole gallery: a host can upload any number of
 * photos, so embedding all of them would make the size of this response depend
 * on how many pictures someone happened to add. The full set stays on
 * `GET /properties/{id}`, which is where a gallery is actually rendered.
 *
 * Composed before `toZodV4SchemaTyped` because the wrapper casts `.shape`
 * away — see the note on that helper.
 */
export const propertyListItemSchema = toZodV4SchemaTyped(
  rawSelectProperty.extend({
    coverImage: rawSelectPropertyImage.nullable(),
  }),
);

export const listPropertiesResponseSchema = z.object({
  data: z.array(propertyListItemSchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});
