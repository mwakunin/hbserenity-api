import { and, count, eq, gte, lte } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, properties } from "@/db/schema";
import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "@/lib/constants";
import { isCheckViolation, pgConstraintName } from "@/lib/db-errors";

import type {
  CreateRoute,
  GetOneRoute,
  ListRoute,
  PatchRoute,
  RemoveRoute,
} from "./properties.routes";

/**
 * A PATCH can't be validated across fields by Zod — it only carries the
 * changed keys, not the resulting row — so the database CHECK constraints are
 * the backstop. Translate them into the same 422 shape Zod produces rather
 * than letting a constraint violation surface as a 500.
 */
const CHECK_MESSAGES: Record<string, { path: string[]; message: string }> = {
  properties_bedrooms_match_type: {
    path: ["bedrooms"],
    message:
      "A studio must have 0 bedrooms; every other property type must have at "
      + "least 1. Count enclosed sleeping rooms, not beds.",
  },
  properties_capacity_positive: {
    path: ["beds"],
    message: "A property must sleep at least one guest and have at least one bed.",
  },
  properties_price_per_night_whole: {
    path: ["pricePerNightCents"],
    message: "Amount must be a whole number of shillings (divisible by 100)",
  },
  properties_cleaning_fee_whole: {
    path: ["cleaningFeeCents"],
    message: "Amount must be a whole number of shillings (divisible by 100)",
  },
};

function checkViolationBody(err: unknown) {
  const constraint = pgConstraintName(err);
  const known = constraint ? CHECK_MESSAGES[constraint] : undefined;

  return {
    success: false as const,
    error: {
      issues: [{
        code: "custom",
        path: known?.path ?? [],
        message: known?.message ?? "That combination of values isn't allowed",
      }],
      name: "ZodError",
    },
  };
}

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const { county, town, propertyType, minGuests, maxPriceCents, page, limit }
    = c.req.valid("query");

  // Only ever expose active listings publicly — drafts and deactivated
  // properties must not leak through the browse endpoint.
  const filters = [eq(properties.status, "active")];

  if (county)
    filters.push(eq(properties.county, county));
  if (town)
    filters.push(eq(properties.town, town));
  if (propertyType)
    filters.push(eq(properties.propertyType, propertyType));
  if (minGuests !== undefined)
    filters.push(gte(properties.maxGuests, minGuests));
  if (maxPriceCents !== undefined)
    filters.push(lte(properties.pricePerNightCents, maxPriceCents));

  const where = and(...filters);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(properties).where(where).limit(limit).offset((page - 1) * limit).orderBy(properties.createdAt),
    db.select({ total: count() }).from(properties).where(where),
  ]);

  return c.json({
    data: rows,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const property = await db.query.properties.findFirst({
    where: eq(properties.id, id),
    with: {
      images: true,
      amenities: { with: { amenity: true } },
    },
  });

  // A draft listing is visible to an admin but must 404 for everyone else,
  // so an unpublished property can't be discovered by guessing ids.
  const isAdmin = c.var.user?.role === "admin";
  if (!property || (property.status !== "active" && !isAdmin)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const { amenities, ...rest } = property;

  return c.json({
    ...rest,
    amenities: amenities.map(a => a.amenity),
  }, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const input = c.req.valid("json");

  try {
    const [created] = await db.insert(properties).values({
      ...input,
      // Single-host model: the authenticated admin owns what they create.
      hostId: c.var.user!.id,
    }).returning();

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isCheckViolation(err))
      return c.json(checkViolationBody(err), HttpStatusCodes.UNPROCESSABLE_ENTITY);
    throw err;
  }
};

export const patch: AppRouteHandler<PatchRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");

  if (Object.keys(updates).length === 0) {
    return c.json(
      {
        success: false,
        error: {
          issues: [{
            code: ZOD_ERROR_CODES.INVALID_UPDATES,
            path: [],
            message: ZOD_ERROR_MESSAGES.NO_UPDATES,
          }],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  let updated;
  try {
    [updated] = await db.update(properties)
      .set(updates)
      .where(eq(properties.id, id))
      .returning();
  }
  catch (err) {
    if (isCheckViolation(err))
      return c.json(checkViolationBody(err), HttpStatusCodes.UNPROCESSABLE_ENTITY);
    throw err;
  }

  if (!updated) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(updated, HttpStatusCodes.OK);
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [existing] = await db.select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, id));

  if (!existing) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // bookings.propertyId is ON DELETE RESTRICT — check first so the caller
  // gets a clear 409 instead of a foreign-key 500.
  const [{ total }] = await db.select({ total: count() })
    .from(bookings)
    .where(eq(bookings.propertyId, id));

  if (total > 0) {
    return c.json(
      { message: "Property has bookings and cannot be deleted. Deactivate it instead." },
      HttpStatusCodes.CONFLICT,
    );
  }

  await db.delete(properties).where(eq(properties.id, id));

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
