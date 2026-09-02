import { asc, eq, inArray } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { amenities, properties, propertyAmenities } from "@/db/schema";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";

import type { CreateRoute, ListRoute, SetForPropertyRoute } from "./amenities.routes";

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const data = await db.select()
    .from(amenities)
    .orderBy(asc(amenities.name));

  return c.json({ data }, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const input = c.req.valid("json");

  try {
    const [created] = await db.insert(amenities).values(input).returning();

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    // `amenities.name` is UNIQUE. Checking first and inserting after would
    // still let two concurrent adds through, so the constraint is the answer
    // and this only turns it into a readable status.
    if (isUniqueViolation(err))
      return c.json({ message: "That amenity already exists" }, HttpStatusCodes.CONFLICT);
    throw err;
  }
};

/** The 422 shape Zod produces, so a client sees one error format. */
function unknownAmenities(ids: string[]) {
  return {
    success: false as const,
    error: {
      issues: [{
        code: "custom",
        path: ["amenityIds"],
        message: ids.length > 0
          ? `Not in the amenity catalogue: ${ids.join(", ")}`
          : "One of those amenities is not in the catalogue",
      }],
      name: "ZodError",
    },
  };
}

type SetResult
  = | { kind: "ok"; data: typeof amenities.$inferSelect[] }
    | { kind: "no-property" }
    | { kind: "unknown-amenities"; ids: string[] };

export const setForProperty: AppRouteHandler<SetForPropertyRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { amenityIds } = c.req.valid("json");

  // A form can tick the same box twice as easily as once, and it means the
  // same thing. `property_amenities_pk` would make the difference a 409.
  const wanted = [...new Set(amenityIds)];

  let result: SetResult;

  try {
    result = await db.transaction(async (tx): Promise<SetResult> => {
      /*
       * Replacing a set is delete-then-insert, which is two statements.
       * Under READ COMMITTED two concurrent replacements each delete only the
       * rows their own statement can see and then both insert, leaving the
       * union of the two sets rather than whichever was sent last. Locking
       * the property serializes them, and it is the same lock bookings and
       * blackouts already take for that property.
       */
      const [property] = await tx.select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, id))
        .for("update");

      if (!property)
        return { kind: "no-property" };

      // Named before anything is written, so a typo'd id says which one
      // rather than surfacing as a foreign key violation. The constraint
      // still backs it up below — this check is two statements away from the
      // insert.
      if (wanted.length > 0) {
        const found = await tx.select({ id: amenities.id })
          .from(amenities)
          .where(inArray(amenities.id, wanted));

        const known = new Set(found.map(row => row.id));
        const missing = wanted.filter(amenityId => !known.has(amenityId));

        if (missing.length > 0)
          return { kind: "unknown-amenities", ids: missing };
      }

      await tx.delete(propertyAmenities)
        .where(eq(propertyAmenities.propertyId, id));

      if (wanted.length > 0) {
        await tx.insert(propertyAmenities).values(
          wanted.map(amenityId => ({ propertyId: id, amenityId })),
        );
      }

      const data = await tx.select({
        id: amenities.id,
        name: amenities.name,
        icon: amenities.icon,
      })
        .from(propertyAmenities)
        .innerJoin(amenities, eq(propertyAmenities.amenityId, amenities.id))
        .where(eq(propertyAmenities.propertyId, id))
        .orderBy(asc(amenities.name));

      return { kind: "ok", data };
    });
  }
  catch (err) {
    // An amenity removed between the check above and the insert. Rare, but
    // the pre-check is for the message, not for the guarantee.
    if (isForeignKeyViolation(err))
      return c.json(unknownAmenities([]), HttpStatusCodes.UNPROCESSABLE_ENTITY);
    throw err;
  }

  if (result.kind === "no-property") {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (result.kind === "unknown-amenities")
    return c.json(unknownAmenities(result.ids), HttpStatusCodes.UNPROCESSABLE_ENTITY);

  return c.json({ data: result.data }, HttpStatusCodes.OK);
};
