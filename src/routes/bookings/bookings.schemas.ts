import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { bookings, propertyBlackouts } from "@/db/schema";
import { MAX_STAY_NIGHTS, nightsBetween } from "@/lib/pricing";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectBookingSchema = toZodV4SchemaTyped(createSelectSchema(bookings));

export const selectBlackoutSchema = toZodV4SchemaTyped(
  createSelectSchema(propertyBlackouts),
);

/**
 * `YYYY-MM-DD`, matching the `date` columns — not a timestamp.
 *
 * z.iso.date() rather than a shape regex: `^\d{4}-\d{2}-\d{2}$` happily
 * accepts 2026-02-30 and 2026-13-45, which Postgres then rejects as
 * "date/time field value out of range" — a 500 for what is really bad input.
 * This validates the calendar, so February 30th is a 422 and February 29th
 * still works in a leap year.
 */
const dateString = z.iso.date().openapi({ example: "2026-09-10" });

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
).refine(
  // Pricing expands the stay night by night, so the same cap that protects
  // the public quote applies here.
  b => nightsBetween(b.checkIn, b.checkOut) <= MAX_STAY_NIGHTS,
  {
    message: `A stay cannot exceed ${MAX_STAY_NIGHTS} nights`,
    path: ["checkOut"],
  },
);

export const availabilityQuerySchema = z.object({
  from: dateString,
  to: dateString,
}).refine(
  // Same ordering rule the booking and blackout schemas enforce. Without it an
  // inverted window silently returns "nothing unavailable", which reads as
  // "these dates are free" rather than "your query was backwards".
  q => q.to > q.from,
  { message: "'to' must be later than 'from'", path: ["to"] },
);

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
