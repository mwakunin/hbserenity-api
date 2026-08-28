import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { propertyRateOverrides } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectRateOverrideSchema = toZodV4SchemaTyped(
  createSelectSchema(propertyRateOverrides),
);

const dateString = z.iso.date().openapi({ example: "2026-12-20" });

/** Mirrors the DB CHECK so a bad amount is a 422 rather than a 500. */
const wholeShillings = z.number().int().nonnegative().refine(
  n => n % 100 === 0,
  "Amount must be a whole number of shillings (divisible by 100)",
);

export const createRateOverrideSchema = z.object({
  propertyId: z.string().uuid(),
  startDate: dateString,
  endDate: dateString,
  pricePerNightCents: wholeShillings.openapi({ example: 1_200_000 }),
  label: z.string().trim().min(1).max(120).optional().openapi({ example: "December high season" }),
}).refine(
  r => r.endDate > r.startDate,
  { message: "End date must be after start date", path: ["endDate"] },
);

export const listRateOverridesResponseSchema = z.object({
  data: z.array(selectRateOverrideSchema),
});

export const quoteQuerySchema = z.object({
  checkIn: dateString,
  checkOut: dateString,
}).refine(
  q => q.checkOut > q.checkIn,
  { message: "Check-out must be after check-in", path: ["checkOut"] },
);

/**
 * Shows the guest what a stay costs before they commit, and why.
 *
 * Without this, seasonal rates are invisible until a booking exists — the
 * guest would discover a December premium only after being charged.
 */
export const quoteResponseSchema = z.object({
  propertyId: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  nights: z.array(z.object({
    night: z.string(),
    rateCents: z.number().int(),
    reason: z.enum(["override", "weekend", "base"]),
  })),
  accommodationCents: z.number().int(),
  cleaningFeeCents: z.number().int(),
  totalCents: z.number().int(),
  currency: z.string(),
});
