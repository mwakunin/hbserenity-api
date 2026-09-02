import { and, asc, count, eq, gt, inArray, lt } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, properties, propertyBlackouts, propertyRateOverrides, user } from "@/db/schema";
import { HOLDING_STATUSES, overlapsWindow } from "@/lib/availability";
import { todayInBusinessZone } from "@/lib/dates";
import { isExclusionViolation } from "@/lib/db-errors";
import { notifyBookingCancelled } from "@/lib/notifications";
import { calculateBookingTotal } from "@/lib/pricing";

import type {
  AvailabilityRoute,
  CancelRoute,
  CreateBlackoutRoute,
  CreateRoute,
  GetOneRoute,
  ListBlackoutsRoute,
  ListRoute,
  RemoveBlackoutRoute,
} from "./bookings.routes";

// Postgres raises 23P01 when an EXCLUDE constraint is violated — that's the
// bookings_no_overlap guard firing. It is the real concurrency defence: two
// simultaneous requests can both pass an application-level availability
// check, but only one can win this.

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
        overlapsWindow(bookings.checkIn, bookings.checkOut, from, to),
      )),
    db.select({ start: propertyBlackouts.startDate, end: propertyBlackouts.endDate })
      .from(propertyBlackouts)
      .where(and(
        eq(propertyBlackouts.propertyId, id),
        overlapsWindow(propertyBlackouts.startDate, propertyBlackouts.endDate, from, to),
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
  const caller = c.var.user!;

  try {
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE locks this property's row for the transaction.
      //
      // booking-vs-booking is already guaranteed by the EXCLUDE constraint,
      // which needs no lock. But booking-vs-blackout spans two tables, where
      // no constraint can reach: without this lock a booking and an
      // overlapping blackout could each pass their own check concurrently and
      // both commit. The lock serializes bookings and blackouts for one
      // property, which is what makes the blackout check below trustworthy.
      //
      // Cost: concurrent bookings for the SAME property queue behind each
      // other. Different properties are unaffected, and correctness is worth
      // far more than parallelism here.
      const [property] = await tx.select()
        .from(properties)
        .where(eq(properties.id, propertyId))
        .for("update");

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
          overlapsWindow(
            propertyBlackouts.startDate,
            propertyBlackouts.endDate,
            checkIn,
            checkOut,
          ),
        ));

      if (blackoutHits > 0)
        return { kind: "conflict" as const };

      // Seasonal rates are read inside the same transaction, under the
      // property lock, so the snapshot cannot be taken against rates that
      // changed midway.
      const overrides = await tx.select({
        startDate: propertyRateOverrides.startDate,
        endDate: propertyRateOverrides.endDate,
        pricePerNightCents: propertyRateOverrides.pricePerNightCents,
      })
        .from(propertyRateOverrides)
        .where(and(
          eq(propertyRateOverrides.propertyId, propertyId),
          overlapsWindow(
            propertyRateOverrides.startDate,
            propertyRateOverrides.endDate,
            checkIn,
            checkOut,
          ),
        ));

      // Server-side price, snapshotted onto the row. Never from the client.
      const totalAmountCents = calculateBookingTotal(
        property,
        checkIn,
        checkOut,
        overrides,
      );

      const [booking] = await tx.insert(bookings).values({
        propertyId,
        guestId: caller.id,
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
  const caller = c.var.user!;

  const filters = [];

  // A guest may only ever see their own bookings.
  if (caller.role !== "admin")
    filters.push(eq(bookings.guestId, caller.id));
  if (status)
    filters.push(eq(bookings.status, status));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    /*
     * Columns are listed rather than spread, and the join takes the guest's
     * display name only. `guestId` on its own cannot be rendered: a host's
     * dashboard would need a request per row to print who booked, and a
     * guest's own trips list would show a uuid.
     *
     * Naming the columns also means a column added to `bookings` later has to
     * be added here deliberately, rather than appearing in the response the
     * day it lands — the same reason the payment history avoids a bare
     * select. `user` carries an email and a phone number that nothing on this
     * endpoint needs.
     */
    db.select({
      id: bookings.id,
      propertyId: bookings.propertyId,
      guestId: bookings.guestId,
      guestName: user.name,
      checkIn: bookings.checkIn,
      checkOut: bookings.checkOut,
      guestCount: bookings.guestCount,
      status: bookings.status,
      totalAmountCents: bookings.totalAmountCents,
      currency: bookings.currency,
      cancelledAt: bookings.cancelledAt,
      cancellationReason: bookings.cancellationReason,
      cancelledBy: bookings.cancelledBy,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
      .from(bookings)
      // Inner: `bookings.guestId` is NOT NULL and references `user`, so a
      // booking without one cannot exist. A left join would quietly turn a
      // broken row into a booking with a null name instead of failing loudly.
      .innerJoin(user, eq(user.id, bookings.guestId))
      .where(where)
      .limit(limit)
      .offset((page - 1) * limit)
      // Two bookings created in the same transaction share a timestamp,
      // which offset pagination cannot order stably on its own.
      .orderBy(asc(bookings.createdAt), asc(bookings.id)),
    db.select({ total: count() }).from(bookings).where(where),
  ]);

  return c.json({
    data: rows,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const caller = c.var.user!;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));

  // 404 rather than 403 for someone else's booking — don't confirm that an id
  // exists to a caller who has no business knowing.
  if (!booking || (caller.role !== "admin" && booking.guestId !== caller.id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(booking, HttpStatusCodes.OK);
};

export const cancel: AppRouteHandler<CancelRoute> = async (c) => {
  const { id } = c.req.valid("param");
  // The body is optional: cancelling an unpaid hold needs no explanation, so
  // a bare POST is valid and arrives here as undefined.
  const { reason } = c.req.valid("json") ?? {};
  const caller = c.var.user!;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));

  if (!booking || (caller.role !== "admin" && booking.guestId !== caller.id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // A stay that is already paid for can still be called off — plans change on
  // both sides. `completed` cannot: that stay happened.
  if (!HOLDING_STATUSES.includes(booking.status as typeof HOLDING_STATUSES[number])) {
    return c.json(
      { message: `A booking with status '${booking.status}' can no longer be cancelled` },
      HttpStatusCodes.CONFLICT,
    );
  }

  // Once the guest is due to arrive there is nothing left to cancel. Allowing
  // it would also free nights that have already been slept in, and drop the
  // booking out of the sweep that makes a finished stay reviewable.
  if (booking.checkIn <= todayInBusinessZone()) {
    return c.json(
      { message: "This stay has already begun and can no longer be cancelled" },
      HttpStatusCodes.CONFLICT,
    );
  }

  // Calling off a stay someone has paid for is the case that gets disputed
  // later, so it does not go on the record unexplained. An unpaid hold is
  // nobody's loss and needs no justification.
  if (booking.status === "confirmed" && !reason) {
    return c.json(
      {
        success: false,
        error: {
          issues: [{
            code: "custom",
            path: ["reason"],
            message: "A reason is required to cancel a booking that has been paid for",
          }],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  // Guarded on the status this call actually validated, not merely on "still
  // cancellable": a booking confirmed between the read and the write would
  // otherwise be cancelled under the unpaid rules, with no reason recorded.
  const [cancelled] = await db.update(bookings)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancellationReason: reason ?? null,
      cancelledBy: caller.id,
    })
    .where(and(eq(bookings.id, id), eq(bookings.status, booking.status)))
    .returning();

  if (!cancelled) {
    return c.json(
      { message: "This booking changed while being cancelled; try again" },
      HttpStatusCodes.CONFLICT,
    );
  }

  // Money already taken is not returned here — refunds are recorded by hand.
  // A successful payment against a cancelled booking is what puts it on
  // GET /admin/payments/attention, which is where the refund gets decided.
  await notifyBookingCancelled(cancelled.id, c.var.logger);

  return c.json(cancelled, HttpStatusCodes.OK);
};

export const createBlackout: AppRouteHandler<CreateBlackoutRoute> = async (c) => {
  const { propertyId, startDate, endDate, reason } = c.req.valid("json");

  try {
    const result = await db.transaction(async (tx) => {
      // Same property-row lock as booking creation (see the note there).
      // Without it an admin could black out dates a guest is booking at the
      // same moment and both would commit: a sold stay marked host-blocked.
      const [property] = await tx.select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, propertyId))
        .for("update");

      if (!property)
        return { kind: "not_found" as const };

      // Blackout-vs-blackout is covered by the EXCLUDE constraint, but
      // blackout-vs-booking spans two tables and cannot be, so check it here
      // under the lock.
      const [{ total: bookedHits }] = await tx.select({ total: count() })
        .from(bookings)
        .where(and(
          eq(bookings.propertyId, propertyId),
          inArray(bookings.status, [...HOLDING_STATUSES]),
          overlapsWindow(bookings.checkIn, bookings.checkOut, startDate, endDate),
        ));

      if (bookedHits > 0)
        return { kind: "booked" as const };

      const [created] = await tx.insert(propertyBlackouts)
        .values({ propertyId, startDate, endDate, reason })
        .returning();

      return { kind: "created" as const, blackout: created };
    });

    switch (result.kind) {
      case "not_found":
        return c.json(
          { message: HttpStatusPhrases.NOT_FOUND },
          HttpStatusCodes.NOT_FOUND,
        );
      case "booked":
        return c.json(
          { message: "These dates are already booked and cannot be blacked out" },
          HttpStatusCodes.CONFLICT,
        );
      case "created":
        return c.json(result.blackout, HttpStatusCodes.CREATED);
    }
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

export const listBlackouts: AppRouteHandler<ListBlackoutsRoute> = async (c) => {
  const { propertyId, from, to, page, limit } = c.req.valid("query");

  const filters = [];

  if (propertyId)
    filters.push(eq(propertyBlackouts.propertyId, propertyId));

  /*
   * Overlap, not containment. A blackout that started last month and runs
   * through next week is exactly the one a calendar showing this week needs
   * to offer for removal, and a `startDate >= from` filter would hide it.
   *
   * Half-open on both sides, like every other range here: a blackout ending
   * on `from` has already released that day, and one starting on `to` falls
   * outside the window.
   */
  if (to)
    filters.push(lt(propertyBlackouts.startDate, to));
  if (from)
    filters.push(gt(propertyBlackouts.endDate, from));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [data, [{ total }]] = await Promise.all([
    db.select()
      .from(propertyBlackouts)
      .where(where)
      .limit(limit)
      .offset((page - 1) * limit)
      // `id` breaks a tie on `startDate`. Ordering by a non-unique column
      // alone leaves offset pagination no stable order, so a row can
      // appear on two pages or on neither.
      .orderBy(asc(propertyBlackouts.startDate), asc(propertyBlackouts.id)),
    db.select({ total: count() }).from(propertyBlackouts).where(where),
  ]);

  return c.json({
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }, HttpStatusCodes.OK);
};

export const removeBlackout: AppRouteHandler<RemoveBlackoutRoute> = async (c) => {
  const { id } = c.req.valid("param");

  // Nothing references a blackout, so this needs neither a lock nor a
  // constraint to catch: the dates simply stop being held. The returning()
  // makes the delete and the existence check one statement, so two concurrent
  // deletes give one 204 and one 404 rather than both claiming success.
  const [deleted] = await db.delete(propertyBlackouts)
    .where(eq(propertyBlackouts.id, id))
    .returning({ id: propertyBlackouts.id });

  if (!deleted) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
