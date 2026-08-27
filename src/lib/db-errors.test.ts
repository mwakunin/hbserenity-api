import { beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { bookings, properties } from "@/db/schema";
import { dayFromNow, makeProperty, nextPhone, resetDb, signIn } from "@/test/helpers";

import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  pgConstraintName,
  pgErrorCode,
} from "./db-errors";

/**
 * These assert against errors drizzle actually throws, not hand-built objects.
 * Drizzle buries the pg error under `DrizzleQueryError.cause`, so a change to
 * how it wraps errors would silently turn every mapped 409/422 back into a
 * 500 — and only a real error can catch that.
 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  }
  catch (err) {
    return err;
  }
  throw new Error("Expected the query to throw, but it succeeded");
}

describe("db error classification", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("detects a foreign key violation (23503)", async () => {
    const guest = await signIn(nextPhone());

    const err = await captureError(() => db.insert(bookings).values({
      // No such property — bookings.property_id is a restricted FK.
      propertyId: "4651e634-a530-4484-9b09-9616a28f35e3",
      guestId: guest.id,
      checkIn: dayFromNow(10),
      checkOut: dayFromNow(13),
      guestCount: 2,
      totalAmountCents: 100_000,
    }));

    expect(pgErrorCode(err)).toBe("23503");
    expect(isForeignKeyViolation(err)).toBe(true);
    expect(isCheckViolation(err)).toBe(false);
    expect(isExclusionViolation(err)).toBe(false);
  });

  it("detects a check violation (23514) and names the constraint", async () => {
    const admin = await signIn(nextPhone(), "admin");

    const err = await captureError(() => db.insert(properties).values({
      hostId: admin.id,
      title: "Bad money",
      description: "Price that is not a whole number of shillings.",
      propertyType: "apartment",
      county: "Nairobi",
      town: "Karen",
      maxGuests: 2,
      bedrooms: 1,
      bathrooms: 1,
      beds: 1,
      pricePerNightCents: 12_345,
    }));

    expect(pgErrorCode(err)).toBe("23514");
    expect(isCheckViolation(err)).toBe(true);
    // The handler maps the constraint name to a field-specific message.
    expect(pgConstraintName(err)).toBe("properties_price_per_night_whole");
  });

  it("detects an exclusion violation (23P01)", async () => {
    const admin = await signIn(nextPhone(), "admin");
    const property = await makeProperty(admin.id);

    const row = {
      propertyId: property.id,
      guestId: admin.id,
      checkIn: dayFromNow(10),
      checkOut: dayFromNow(15),
      guestCount: 2,
      totalAmountCents: 100_000,
    };
    await db.insert(bookings).values(row);

    const err = await captureError(() => db.insert(bookings).values(row));

    expect(pgErrorCode(err)).toBe("23P01");
    expect(isExclusionViolation(err)).toBe(true);
    expect(pgConstraintName(err)).toBe("bookings_no_overlap");
  });

  it("survives errors that carry no SQLSTATE", () => {
    expect(pgErrorCode(new Error("boom"))).toBeUndefined();
    expect(isForeignKeyViolation(new Error("boom"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
    expect(pgConstraintName({})).toBeUndefined();
  });

  it("does not loop forever on a self-referencing cause chain", () => {
    const err: { code?: string; cause?: unknown } = {};
    err.cause = err;
    expect(pgErrorCode(err)).toBeUndefined();
  });
});
