import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { properties } from "@/db/schema";
import { backendPid, makeProperty, nextPhone, resetDb, signIn, waitForBlockedBackend } from "@/test/helpers";

/** Fixed dates so weekday arithmetic is stable: 10th is a Thursday. */
const THU = "2026-09-10";
const FRI = "2026-09-11";
const SUN = "2026-09-13";

describe("seasonal rates", () => {
  let admin: TestUser;
  let guest: TestUser;
  let propertyId: string;

  beforeEach(async () => {
    await resetDb();
    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id, {
      pricePerNightCents: 800_000,
      cleaningFeeCents: 150_000,
      weekendPriceCents: 1_000_000,
    });
    propertyId = property.id;
  });

  async function createOverride(user: TestUser, body: object): Promise<Response> {
    return app.request("/rate-overrides", {
      method: "POST",
      headers: { "content-type": "application/json", ...user.headers },
      body: JSON.stringify({ propertyId, ...body }),
    });
  }

  describe("managing overrides", () => {
    it("lets an admin price a date range", async () => {
      const res = await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
        label: "Festival weekend",
      });
      expect(res.status).toBe(201);
    });

    it("403s a guest", async () => {
      const res = await createOverride(guest, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
      });
      expect(res.status).toBe(403);
    });

    it("404s an unknown property", async () => {
      const res = await app.request("/rate-overrides", {
        method: "POST",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({
          propertyId: "4651e634-a530-4484-9b09-9616a28f35e3",
          startDate: THU,
          endDate: SUN,
          pricePerNightCents: 1_500_000,
        }),
      });
      expect(res.status).toBe(404);
    });

    // A night covered by two overrides has no defined price.
    it("409s an overlapping override", async () => {
      await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
      });

      const res = await createOverride(admin, {
        startDate: FRI,
        endDate: "2026-09-15",
        pricePerNightCents: 900_000,
      });
      expect(res.status).toBe(409);
    });

    it("allows a range starting where another ends", async () => {
      await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
      });

      // Half-open, so the 13th is free.
      const res = await createOverride(admin, {
        startDate: SUN,
        endDate: "2026-09-16",
        pricePerNightCents: 900_000,
      });
      expect(res.status).toBe(201);
    });

    it("keeps only one of two concurrent overlapping overrides", async () => {
      const results = await Promise.all([
        createOverride(admin, { startDate: THU, endDate: SUN, pricePerNightCents: 1_500_000 }),
        createOverride(admin, { startDate: THU, endDate: SUN, pricePerNightCents: 900_000 }),
      ]);
      expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    });

    it("422s a price that is not a whole number of shillings", async () => {
      const res = await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 12_345,
      });
      expect(res.status).toBe(422);
    });

    it("422s an end date before the start", async () => {
      const res = await createOverride(admin, {
        startDate: SUN,
        endDate: THU,
        pricePerNightCents: 900_000,
      });
      expect(res.status).toBe(422);
    });

    it("lists and removes overrides", async () => {
      const created = await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
      });
      const { id } = await created.json();

      const listed = await app.request(`/properties/${propertyId}/rate-overrides`, {
        headers: admin.headers,
      });
      expect((await listed.json()).data).toHaveLength(1);

      const removed = await app.request(`/rate-overrides/${id}`, {
        method: "DELETE",
        headers: admin.headers,
      });
      expect(removed.status).toBe(204);

      const after = await app.request(`/properties/${propertyId}/rate-overrides`, {
        headers: admin.headers,
      });
      expect((await after.json()).data).toEqual([]);
    });
  });

  describe("quoting", () => {
    const quote = (from = THU, to = SUN) =>
      app.request(`/properties/${propertyId}/quote?checkIn=${from}&checkOut=${to}`);

    it("is public", async () => {
      expect((await quote()).status).toBe(200);
    });

    it("explains why each night costs what it does", async () => {
      const { nights, totalCents } = await (await quote()).json();

      expect(nights).toEqual([
        { night: THU, rateCents: 800_000, reason: "base" },
        { night: FRI, rateCents: 1_000_000, reason: "weekend" },
        { night: "2026-09-12", rateCents: 1_000_000, reason: "weekend" },
      ]);
      expect(totalCents).toBe(800_000 + 1_000_000 + 1_000_000 + 150_000);
    });

    it("reflects a seasonal override", async () => {
      await createOverride(admin, {
        startDate: THU,
        endDate: FRI,
        pricePerNightCents: 1_500_000,
      });

      const { nights } = await (await quote()).json();
      expect(nights[0]).toEqual({ night: THU, rateCents: 1_500_000, reason: "override" });
    });

    it("separates accommodation from the cleaning fee", async () => {
      const { accommodationCents, cleaningFeeCents, totalCents } = await (await quote()).json();
      expect(accommodationCents + cleaningFeeCents).toBe(totalCents);
      expect(cleaningFeeCents).toBe(150_000);
    });

    it("422s a check-out that is not after check-in", async () => {
      expect((await quote(SUN, THU)).status).toBe(422);
    });

    it("404s a property that is not bookable", async () => {
      const draft = await makeProperty(admin.id, { status: "draft" });
      const res = await app.request(
        `/properties/${draft.id}/quote?checkIn=${THU}&checkOut=${SUN}`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("bounded stay length", () => {
    // The quote allocates one object per night, so an unbounded range on a
    // public endpoint is a denial of service, not just a large answer.
    it("422s a quote spanning decades", async () => {
      const res = await app.request(
        `/properties/${propertyId}/quote?checkIn=2020-01-01&checkOut=9999-12-31`,
      );
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/cannot exceed 365 nights/);
    });

    it("422s a booking spanning decades", async () => {
      const res = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: "2020-01-01",
          checkOut: "9999-12-31",
          guestCount: 2,
        }),
      });
      expect(res.status).toBe(422);
    });

    it("allows a stay right at the limit", async () => {
      const res = await app.request(
        `/properties/${propertyId}/quote?checkIn=2026-01-01&checkOut=2027-01-01`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).nights).toHaveLength(365);
    });

    it("422s one night past the limit", async () => {
      const res = await app.request(
        `/properties/${propertyId}/quote?checkIn=2026-01-01&checkOut=2027-01-02`,
      );
      expect(res.status).toBe(422);
    });
  });

  describe("rate writes and booking price snapshots", () => {
    // Booking creation holds a FOR UPDATE lock on the property while it reads
    // rates and computes the total, so a rate write must not slip in midway.
    //
    // For an INSERT this is already guaranteed without the handler's own
    // lock: the foreign key to properties takes a KEY SHARE lock that
    // conflicts with FOR UPDATE. So this asserts the property holds, not that
    // the handler's lock is what provides it — the delete test below is the
    // one that isolates that.
    it("waits for a transaction holding the property lock", async () => {
      let finished = false;
      let finishedWhileLocked: boolean | null = null;
      let writer: Promise<Response> | undefined;

      await db.transaction(async (tx) => {
        // Take the lock exactly as booking creation does.
        await tx.select({ id: properties.id })
          .from(properties)
          .where(eq(properties.id, propertyId))
          .for("update");

        const holder = await backendPid(tx);

        writer = createOverride(admin, {
          startDate: THU,
          endDate: SUN,
          pricePerNightCents: 1_500_000,
        }).then((r: Response) => {
          finished = true;
          return r;
        });

        expect(await waitForBlockedBackend(holder)).toBe(true);
        finishedWhileLocked = finished;
      });

      const res = await writer!;

      // Blocked while the lock was held, and succeeded once it was released.
      expect(finishedWhileLocked).toBe(false);
      expect(res.status).toBe(201);
    });

    // Deleting a child row does not touch the parent's foreign key, so unlike
    // an insert this is NOT serialized for free — the explicit lock is what
    // stops a removal landing inside a booking's price computation.
    it("waits for the property lock before removing a rate", async () => {
      const created = await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
      });
      const { id } = await created.json();

      let finished = false;
      let finishedWhileLocked: boolean | null = null;
      let remover: Promise<Response> | undefined;

      await db.transaction(async (tx) => {
        await tx.select({ id: properties.id })
          .from(properties)
          .where(eq(properties.id, propertyId))
          .for("update");

        const holder = await backendPid(tx);

        remover = Promise.resolve(app.request(`/rate-overrides/${id}`, {
          method: "DELETE",
          headers: admin.headers,
        })).then((r: Response) => {
          finished = true;
          return r;
        });

        expect(await waitForBlockedBackend(holder)).toBe(true);
        finishedWhileLocked = finished;
      });

      const res = await remover!;
      expect(finishedWhileLocked).toBe(false);
      expect(res.status).toBe(204);
    });

    it("does not block a write to a different property", async () => {
      const other = await makeProperty(admin.id, { title: "Elsewhere" });

      await db.transaction(async (tx) => {
        await tx.select({ id: properties.id })
          .from(properties)
          .where(eq(properties.id, propertyId))
          .for("update");

        // A lock on one property must not serialize every other property's
        // rate changes.
        const res = await app.request("/rate-overrides", {
          method: "POST",
          headers: { "content-type": "application/json", ...admin.headers },
          body: JSON.stringify({
            propertyId: other.id,
            startDate: THU,
            endDate: SUN,
            pricePerNightCents: 900_000,
          }),
        });
        expect(res.status).toBe(201);
      });
    });
  });

  describe("what the guest is actually charged", () => {
    // A quote that disagreed with the charge would be worse than no quote.
    it("charges exactly what the quote said", async () => {
      await createOverride(admin, {
        startDate: THU,
        endDate: FRI,
        pricePerNightCents: 1_500_000,
      });

      const quoted = await (await app.request(
        `/properties/${propertyId}/quote?checkIn=${THU}&checkOut=${SUN}`,
      )).json();

      const booked = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: THU,
          checkOut: SUN,
          guestCount: 2,
        }),
      });

      expect(booked.status).toBe(201);
      expect((await booked.json()).totalAmountCents).toBe(quoted.totalCents);
    });

    it("keeps the snapshot when the seasonal rate is removed afterwards", async () => {
      const created = await createOverride(admin, {
        startDate: THU,
        endDate: SUN,
        pricePerNightCents: 1_500_000,
      });
      const { id } = await created.json();

      const booked = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: THU,
          checkOut: SUN,
          guestCount: 2,
        }),
      });
      const total = (await booked.json()).totalAmountCents;
      expect(total).toBe(3 * 1_500_000 + 150_000);

      await app.request(`/rate-overrides/${id}`, {
        method: "DELETE",
        headers: admin.headers,
      });

      const stored = await app.request(`/bookings`, { headers: guest.headers });
      expect((await stored.json()).data[0].totalAmountCents).toBe(total);
    });
  });
});
