import { asc, avg, count, desc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, properties, reviews, user } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";

import type { CreateRoute, ListForPropertyRoute } from "./reviews.routes";

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { rating, comment } = c.req.valid("json");
  const caller = c.var.user!;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));

  // 404 rather than 403 for someone else's booking, matching the rest of the
  // API — an id you don't own shouldn't be confirmable as existing.
  if (!booking || booking.guestId !== caller.id) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // Only a finished stay can be reviewed. `completed` is set by the
  // reconciliation sweep once the check-out date has passed, so this is what
  // "you actually stayed here" means in practice.
  if (booking.status !== "completed") {
    return c.json(
      {
        message: booking.status === "confirmed"
          ? "This stay hasn't finished yet."
          : `A booking with status '${booking.status}' cannot be reviewed.`,
      },
      HttpStatusCodes.CONFLICT,
    );
  }

  try {
    const [review] = await db.insert(reviews).values({
      bookingId: booking.id,
      // Both derived from the booking, never from the request — otherwise a
      // review could be attached to a property the guest never stayed at.
      propertyId: booking.propertyId,
      guestId: booking.guestId,
      rating,
      comment,
    }).returning();

    return c.json(review, HttpStatusCodes.CREATED);
  }
  catch (err) {
    // reviews_booking_idx is unique: one review per stay. Two concurrent
    // submissions both pass the checks above, so the constraint is the guard.
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "This stay has already been reviewed." },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const listForProperty: AppRouteHandler<ListForPropertyRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { page, limit } = c.req.valid("query");

  const [property] = await db.select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, id));

  if (!property) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const where = eq(reviews.propertyId, id);

  const [rows, [totals]] = await Promise.all([
    db.select({
      id: reviews.id,
      propertyId: reviews.propertyId,
      rating: reviews.rating,
      comment: reviews.comment,
      // The reviewer's display name only — never their id or contact details.
      guestName: user.name,
      createdAt: reviews.createdAt,
    })
      .from(reviews)
      .innerJoin(user, eq(user.id, reviews.guestId))
      .where(where)
      // Unique tiebreaker, or a page boundary falling between two reviews
      // with the same timestamp can repeat or drop one.
      .orderBy(desc(reviews.createdAt), asc(reviews.id))
      .limit(limit)
      .offset((page - 1) * limit),

    // Computed over every review, not the page — an average of one page would
    // be misleading.
    db.select({ total: count(), average: avg(reviews.rating) })
      .from(reviews)
      .where(where),
  ]);

  return c.json({
    data: rows,
    summary: {
      // avg() comes back as a string, and null when there are no rows.
      averageRating: totals.average === null
        ? null
        : Math.round(Number(totals.average) * 10) / 10,
      count: totals.total,
    },
    meta: {
      page,
      limit,
      total: totals.total,
      totalPages: Math.ceil(totals.total / limit),
    },
  }, HttpStatusCodes.OK);
};
