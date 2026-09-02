import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";
import { z as z4 } from "zod/v4";

import { bookings, propertyBlackouts } from "@/db/schema";
import { MAX_STAY_NIGHTS, nightsBetween } from "@/lib/pricing";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

// Kept unwrapped so the list item can `.extend()` it — toZodV4SchemaTyped
// casts away the object shape that composition needs.
const rawSelectBooking = createSelectSchema(bookings);

export const selectBookingSchema = toZodV4SchemaTyped(rawSelectBooking);

/**
 * A booking as it appears in a list, plus who made it.
 *
 * `guestId` alone cannot be rendered: a dashboard would have to fetch a user
 * per row to print a name, and the guest's own trips list would show a uuid.
 * The display name only — never their email or phone, which the caller has no
 * need for here and which would then have to be redacted from a shared cache.
 */
export const bookingListItemSchema = toZodV4SchemaTyped(
  rawSelectBooking.extend({
    guestName: z4.string(),
  }),
);

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
  data: z.array(bookingListItemSchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

/**
 * Which blackouts to list.
 *
 * `propertyId` is optional so the whole calendar can be reviewed at once, but
 * a calendar view passes it. `from`/`to` bound the window the same half-open
 * way as everything else: a blackout is included when it overlaps the window,
 * so one that started before `from` and is still running shows up.
 */
export const listBlackoutsQuerySchema = z.object({
  propertyId: z.string().uuid().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
}).refine(
  q => q.from === undefined || q.to === undefined || q.to > q.from,
  { message: "to must be after from", path: ["to"] },
);

export const listBlackoutsResponseSchema = z.object({
  data: z.array(selectBlackoutSchema),
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

/**
 * Why a booking is being called off.
 *
 * Optional here because an unpaid hold needs no justification. The handler
 * requires it once money has been taken — a rule Zod cannot express, since the
 * body does not say what the booking's status is.
 */
export const cancelBookingSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional().openapi({
    example: "Guest's travel plans changed",
  }),
});
