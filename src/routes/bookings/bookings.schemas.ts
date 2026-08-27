import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { bookings, propertyBlackouts } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectBookingSchema = toZodV4SchemaTyped(createSelectSchema(bookings));

export const selectBlackoutSchema = toZodV4SchemaTyped(
  createSelectSchema(propertyBlackouts),
);

/** `YYYY-MM-DD`, matching the `date` columns — not a timestamp. */
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a calendar date in YYYY-MM-DD form")
  .openapi({ example: "2026-09-10" });

/**
 * Note what is absent: no price field. The total is computed server-side from
 * the property's current rate and snapshotted — a client-sent amount would be
 * a way to book a villa for one shilling.
 */
export const createBookingSchema = z.object({
  propertyId: z.string().uuid(),
  checkIn: dateString,
  checkOut: dateString,
  guestCount: z.number().int().positive().max(100),
}).refine(
  b => b.checkOut > b.checkIn,
  { message: "Check-out must be after check-in", path: ["checkOut"] },
);

export const availabilityQuerySchema = z.object({
  from: dateString,
  to: dateString,
});

export const availabilityResponseSchema = z.object({
  propertyId: z.string(),
  from: z.string(),
  to: z.string(),
  /** Ranges that are taken, half-open `[start, end)`. */
  unavailable: z.array(z.object({
    start: z.string(),
    end: z.string(),
    reason: z.enum(["booked", "blackout"]),
  })),
});

export const listBookingsQuerySchema = z.object({
  status: z.enum(["pending_payment", "confirmed", "cancelled", "completed"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const listBookingsResponseSchema = z.object({
  data: z.array(selectBookingSchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const createBlackoutSchema = z.object({
  propertyId: z.string().uuid(),
  startDate: dateString,
  endDate: dateString,
  reason: z.string().max(500).optional(),
}).refine(
  b => b.endDate > b.startDate,
  { message: "End date must be after start date", path: ["endDate"] },
);
