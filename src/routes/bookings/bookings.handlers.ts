import { and, count, eq, gt, inArray, lt } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, properties, propertyBlackouts } from "@/db/schema";
import { calculateBookingTotal } from "@/lib/pricing";

import type {
  AvailabilityRoute,
  CancelRoute,
  CreateBlackoutRoute,
  CreateRoute,
  GetOneRoute,
  ListRoute,
} from "./bookings.routes";

/** Booking statuses that actually hold dates against other guests. */
const HOLDING_STATUSES = ["pending_payment", "confirmed"] as const;

/** SQLSTATE for exclusion_violation. */
const EXCLUSION_VIOLATION = "23P01";

/**
 * Postgres raises 23P01 when an EXCLUDE constraint is violated — that's the
 * bookings_no_overlap guard firing. It is the real concurrency defence: two
 * simultaneous requests can both pass an application-level availability
 * check, but only one can win this.
 *
 * Drizzle wraps driver errors in a DrizzleQueryError and hangs the original
 * pg error off `.cause`, so the code is never on the top-level object —
 * walk the chain rather than checking one level.
 */
function isExclusionViolation(err: unknown): boolean {
  let current = err;

  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current === "object" && "code" in current
      && (current as { code?: unknown }).code === EXCLUSION_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

export const availability: AppRouteHandler<AvailabilityRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { from, to } = c.req.valid("query");

  const [property] = await db.select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, id));

  if (!property) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // Half-open overlap test: a range [start, end) intersects the window
  // [from, to) when start < to AND end > from.
  const [booked, blacked] = await Promise.all([
    db.select({ start: bookings.checkIn, end: bookings.checkOut })
      .from(bookings)
      .where(and(
        eq(bookings.propertyId, id),
        inArray(bookings.status, [...HOLDING_STATUSES]),
        lt(bookings.checkIn, to),
        gt(bookings.checkOut, from),
      )),
    db.select({ start: propertyBlackouts.startDate, end: propertyBlackouts.endDate })
      .from(propertyBlackouts)
      .where(and(
        eq(propertyBlackouts.propertyId, id),
        lt(propertyBlackouts.startDate, to),
        gt(propertyBlackouts.endDate, from),
      )),
  ]);

  const unavailable = [
    ...booked.map(r => ({ ...r, reason: "booked" as const })),
    ...blacked.map(r => ({ ...r, reason: "blackout" as const })),
  ].sort((a, b) => a.start.localeCompare(b.start));

  return c.json({ propertyId: id, from, to, unavailable }, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const { propertyId, checkIn, checkOut, guestCount } = c.req.valid("json");
  const user = c.var.user!;

  try {
    const result = await db.transaction(async (tx) => {
      const [property] = await tx.select()
        .from(properties)
        .where(eq(properties.id, propertyId));

      if (!property || property.status !== "active")
        return { kind: "not_found" as const };

      if (guestCount > property.maxGuests) {
        return {
          kind: "too_many_guests" as const,
          max: property.maxGuests,
        };
      }

      // Blackouts live in a different table, so the EXCLUDE constraint can't
      // cover booking-vs-blackout. Check it explicitly inside the transaction.
      const [{ total: blackoutHits }] = await tx.select({ total: count() })
        .from(propertyBlackouts)
        .where(and(
          eq(propertyBlackouts.propertyId, propertyId),
          lt(propertyBlackouts.startDate, checkOut),
          gt(propertyBlackouts.endDate, checkIn),
        ));

      if (blackoutHits > 0)
        return { kind: "conflict" as const };

      // Server-side price, snapshotted onto the row. Never from the client.
      const totalAmountCents = calculateBookingTotal(property, checkIn, checkOut);

      const [booking] = await tx.insert(bookings).values({
        propertyId,
        guestId: user.id,
        checkIn,
        checkOut,
        guestCount,
        totalAmountCents,
        currency: property.currency,
      }).returning();

      return { kind: "created" as const, booking };
    });

    switch (result.kind) {
      case "not_found":
        return c.json(
          { message: HttpStatusPhrases.NOT_FOUND },
          HttpStatusCodes.NOT_FOUND,
        );
      case "too_many_guests":
        return c.json(
          {
            success: false,
            error: {
              issues: [{
                code: "too_big",
                path: ["guestCount"],
                message: `This property sleeps at most ${result.max} guests`,
              }],
              name: "ZodError",
            },
          },
          HttpStatusCodes.UNPROCESSABLE_ENTITY,
        );
      case "conflict":
        return c.json(
          { message: "These dates are no longer available" },
          HttpStatusCodes.CONFLICT,
        );
      case "created":
        return c.json(result.booking, HttpStatusCodes.CREATED);
    }
  }
  catch (err) {
    if (isExclusionViolation(err)) {
      return c.json(
        { message: "These dates are no longer available" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const { status, page, limit } = c.req.valid("query");
  const user = c.var.user!;

  const filters = [];

  // A guest may only ever see their own bookings.
  if (user.role !== "admin")
    filters.push(eq(bookings.guestId, user.id));
  if (status)
    filters.push(eq(bookings.status, status));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(bookings).where(where).limit(limit).offset((page - 1) * limit).orderBy(bookings.createdAt),
    db.select({ total: count() }).from(bookings).where(where),
  ]);

  return c.json({
    data: rows,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const user = c.var.user!;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));

  // 404 rather than 403 for someone else's booking — don't confirm that an id
  // exists to a caller who has no business knowing.
  if (!booking || (user.role !== "admin" && booking.guestId !== user.id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(booking, HttpStatusCodes.OK);
};

export const cancel: AppRouteHandler<CancelRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const user = c.var.user!;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));

  if (!booking || (user.role !== "admin" && booking.guestId !== user.id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // Lifecycle: pending_payment -> cancelled is the only legal cancellation.
  if (booking.status !== "pending_payment") {
    return c.json(
      { message: `A booking with status '${booking.status}' can no longer be cancelled` },
      HttpStatusCodes.CONFLICT,
    );
  }

  const [cancelled] = await db.update(bookings)
    .set({ status: "cancelled" })
    .where(and(eq(bookings.id, id), eq(bookings.status, "pending_payment")))
    .returning();

  if (!cancelled) {
    return c.json(
      { message: "This booking can no longer be cancelled" },
      HttpStatusCodes.CONFLICT,
    );
  }

  return c.json(cancelled, HttpStatusCodes.OK);
};

export const createBlackout: AppRouteHandler<CreateBlackoutRoute> = async (c) => {
  const { propertyId, startDate, endDate, reason } = c.req.valid("json");

  const [property] = await db.select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, propertyId));

  if (!property) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  try {
    const [created] = await db.insert(propertyBlackouts)
      .values({ propertyId, startDate, endDate, reason })
      .returning();

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isExclusionViolation(err)) {
      return c.json(
        { message: "These dates overlap an existing blackout" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};
