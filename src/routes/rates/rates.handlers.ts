import { and, asc, eq, gt, lt } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { properties, propertyRateOverrides } from "@/db/schema";
import { isExclusionViolation } from "@/lib/db-errors";
import { nightlyBreakdown } from "@/lib/pricing";

import type {
  CreateOverrideRoute,
  ListForPropertyRoute,
  QuoteRoute,
  RemoveOverrideRoute,
} from "./rates.routes";

export const createOverride: AppRouteHandler<CreateOverrideRoute> = async (c) => {
  const { propertyId, startDate, endDate, pricePerNightCents, label }
    = c.req.valid("json");

  try {
    const created = await db.transaction(async (tx) => {
      // Takes the same property lock booking creation holds. Without it a
      // rate change can commit midway through a booking's price computation,
      // so the snapshot would include or omit it depending on timing. Holding
      // the lock makes the booking see one stable set of rates.
      const [property] = await tx.select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, propertyId))
        .for("update");

      if (!property)
        return null;

      const [row] = await tx.insert(propertyRateOverrides)
        .values({ propertyId, startDate, endDate, pricePerNightCents, label })
        .returning();

      return row;
    });

    if (!created) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    // property_rate_overrides_no_overlap. A pre-check cannot hold: two
    // concurrent inserts both see no conflict, and a night with two prices
    // has no defined answer.
    if (isExclusionViolation(err)) {
      return c.json(
        { message: "These dates overlap an existing rate for this property" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const listForProperty: AppRouteHandler<ListForPropertyRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [property] = await db.select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, id));

  if (!property) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const data = await db.select().from(propertyRateOverrides).where(eq(propertyRateOverrides.propertyId, id)).orderBy(asc(propertyRateOverrides.startDate));

  return c.json({ data }, HttpStatusCodes.OK);
};

export const removeOverride: AppRouteHandler<RemoveOverrideRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const removed = await db.transaction(async (tx) => {
    const [existing] = await tx.select({ propertyId: propertyRateOverrides.propertyId })
      .from(propertyRateOverrides)
      .where(eq(propertyRateOverrides.id, id));

    if (!existing)
      return null;

    // Same lock as createOverride, for the same reason: a removal must not
    // land in the middle of a booking pricing itself.
    await tx.select({ id: properties.id })
      .from(properties)
      .where(eq(properties.id, existing.propertyId))
      .for("update");

    const [row] = await tx.delete(propertyRateOverrides)
      .where(eq(propertyRateOverrides.id, id))
      .returning({ id: propertyRateOverrides.id });

    return row ?? null;
  });

  if (!removed) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};

export const quote: AppRouteHandler<QuoteRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { checkIn, checkOut } = c.req.valid("query");

  const [property] = await db.select().from(properties).where(eq(properties.id, id));

  // Only quote what can actually be booked, so a draft listing's price is not
  // discoverable by guessing ids.
  if (!property || property.status !== "active") {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const overrides = await db.select({
    startDate: propertyRateOverrides.startDate,
    endDate: propertyRateOverrides.endDate,
    pricePerNightCents: propertyRateOverrides.pricePerNightCents,
  })
    .from(propertyRateOverrides)
    .where(and(
      eq(propertyRateOverrides.propertyId, id),
      lt(propertyRateOverrides.startDate, checkOut),
      gt(propertyRateOverrides.endDate, checkIn),
    ));

  const nights = nightlyBreakdown(property, checkIn, checkOut, overrides);
  const accommodationCents = nights.reduce((sum, n) => sum + n.rateCents, 0);

  return c.json({
    propertyId: id,
    checkIn,
    checkOut,
    nights,
    accommodationCents,
    cleaningFeeCents: property.cleaningFeeCents,
    // Same arithmetic the booking performs, so a quote and the charge agree.
    totalCents: accommodationCents + property.cleaningFeeCents,
    currency: property.currency,
  }, HttpStatusCodes.OK);
};
