import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { reviews } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectReviewSchema = toZodV4SchemaTyped(createSelectSchema(reviews));

/**
 * Note what the client does not send: propertyId or guestId.
 *
 * Both are derived from the booking being reviewed. Accepting them would let
 * someone attach a review to a property they never stayed at.
 */
export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
  comment: z.string().trim().min(1).max(2000).optional(),
});

/** A review as shown publicly — the reviewer's name, never their identifiers. */
export const publicReviewSchema = z.object({
  id: z.string(),
  propertyId: z.string(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  guestName: z.string(),
  createdAt: z.date(),
});

export const listReviewsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const listReviewsResponseSchema = z.object({
  data: z.array(publicReviewSchema),
  summary: z.object({
    /** Null until the property has its first review. */
    averageRating: z.number().nullable(),
    count: z.number().int(),
  }),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});
