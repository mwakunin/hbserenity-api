import { and, count, eq, gte, lte } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, properties } from "@/db/schema";
import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "@/lib/constants";
import { isCheckViolation, isForeignKeyViolation, pgConstraintName } from "@/lib/db-errors";

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
  const { county, town, propertyType, minGuests, maxPriceCents, status, page, limit }
    = c.req.valid("query");

  const isAdmin = c.var.user?.role === "admin";

  /*
   * "active" is an unconditional floor for anyone who is not an admin.
   *
   * Written this way round on purpose: the branch that widens the filter is
   * the exception, so a mistake in it leaves the public endpoint too strict
   * rather than leaking a draft. `status` is simply ignored for a non-admin —
   * refusing it would confirm that other statuses exist, and there is nothing
   * a guest could legitimately do with the answer.
   *
   * The default stays "active" even for an admin, so browsing the site as one
   * shows the same listings a guest sees. Seeing drafts is opt-in.
   */
  const filters = [];
  let widenedForAdmin = false;

  if (isAdmin && status) {
    if (status !== "all")
      filters.push(eq(properties.status, status));
    // `status=active` asks for exactly the public list, so it is not widened.
    widenedForAdmin = status !== "active";
  }
  else {
    filters.push(eq(properties.status, "active"));
  }

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

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    /*
     * The cover is chosen by the database, and only the cover is read.
     *
     * `property_images_one_cover_idx` guarantees at most one cover per
     * property but not that there is one — a host can upload photos and never
     * pick. Ordering cover-first and falling back to the lowest `order` means
     * a listing with pictures always shows one rather than looking photoless
     * because nobody pressed a button; `id` only breaks a tie on `order`, so
     * the same photo comes back on every request instead of flapping.
     *
     * `limit: 1` is what keeps this response bounded. Drizzle builds the
     * relation as a lateral subquery — one row per listing, no fan-out to
     * collapse — and the limit applies inside it, per listing. Reading whole
     * galleries and picking in JS instead would make transfer, memory and
     * sorting work grow with how many photos a host happened to upload, to
     * return exactly one of them.
     */
    db.query.properties.findMany({
      where,
      with: {
        images: {
          limit: 1,
          orderBy: (image, { asc, desc }) => [
            desc(image.isCover),
            asc(image.order),
            asc(image.id),
          ],
        },
      },
      limit,
      offset: (page - 1) * limit,
      orderBy: properties.createdAt,
    }),
    db.select({ total: count() }).from(properties).where(where),
  ]);

  // Same URL, different answer depending on who asked: `?status=all` returns
  // drafts to an admin and only active listings to everyone else. A shared
  // cache keyed on the URL would store the admin's copy and replay it to
  // anonymous visitors, so the widened response must not be stored. Sessions
  // are cookie-based, which means the Authorization-header exemption that
  // normally keeps shared caches off authenticated responses does not apply.
  if (widenedForAdmin)
    c.header("Cache-Control", "no-store");

  return c.json({
    data: rows.map(({ images, ...property }) => ({
      ...property,
      coverImage: images[0] ?? null,
    })),
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

  // This response depends on who is asking: an admin sees a draft that
  // everyone else gets a 404 for. A shared cache must not store the admin's
  // copy and replay it to anonymous visitors, which would leak an unpublished
  // listing.
  if (property.status !== "active")
    c.header("Cache-Control", "no-store");

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

  const conflict = {
    message: "Property has bookings and cannot be deleted. Deactivate it instead.",
  };

  // bookings.propertyId is ON DELETE RESTRICT. Counting first gives the caller
  // a clear 409 in the ordinary case...
  const [{ total }] = await db.select({ total: count() })
    .from(bookings)
    .where(eq(bookings.propertyId, id));

  if (total > 0)
    return c.json(conflict, HttpStatusCodes.CONFLICT);

  try {
    await db.delete(properties).where(eq(properties.id, id));
  }
  catch (err) {
    // ...but the count and the delete are separate statements, so a booking
    // arriving in between makes the foreign key fire. That is the same
    // conflict, not a server fault — report it identically rather than 500.
    if (isForeignKeyViolation(err))
      return c.json(conflict, HttpStatusCodes.CONFLICT);
    throw err;
  }

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
