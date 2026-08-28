import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { bookings, reviews } from "@/db/schema";
import { dayFromNow, makeProperty, nextPhone, resetDb, signIn } from "@/test/helpers";

describe("reviews", () => {
  let admin: TestUser;
  let guest: TestUser;
  let propertyId: string;
  let bookingId: string;

  beforeEach(async () => {
    await resetDb();
    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id);
    propertyId = property.id;

    const [booking] = await db.insert(bookings).values({
      propertyId,
      guestId: guest.id,
      checkIn: dayFromNow(-10),
      checkOut: dayFromNow(-7),
      guestCount: 2,
      totalAmountCents: 2_700_000,
      status: "completed",
    }).returning();
    bookingId = booking.id;
  });

  function post(user: TestUser, id: string, body: object) {
    return app.request(`/bookings/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", ...user.headers },
      body: JSON.stringify(body),
    });
  }

  describe("writing a review", () => {
    it("accepts a review of a completed stay", async () => {
      const res = await post(guest, bookingId, { rating: 5, comment: "Lovely" });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.rating).toBe(5);
      // Derived from the booking, so a guest cannot point a review elsewhere.
      expect(json.propertyId).toBe(propertyId);
      expect(json.guestId).toBe(guest.id);
    });

    it("accepts a rating with no comment", async () => {
      expect((await post(guest, bookingId, { rating: 4 })).status).toBe(201);
    });

    it("requires authentication", async () => {
      const res = await app.request(`/bookings/${bookingId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: 5 }),
      });
      expect(res.status).toBe(401);
    });

    // The whole point of tying a review to a booking: you cannot review
    // somewhere you never stayed.
    it("404s someone else's booking", async () => {
      const other = await signIn(nextPhone());
      expect((await post(other, bookingId, { rating: 1 })).status).toBe(404);
    });

    it("404s an unknown booking", async () => {
      const res = await post(guest, "4651e634-a530-4484-9b09-9616a28f35e3", { rating: 5 });
      expect(res.status).toBe(404);
    });

    it.each(["pending_payment", "confirmed", "cancelled"] as const)(
      "409s a booking that is %s rather than completed",
      async (status) => {
        await db.update(bookings).set({ status }).where(eq(bookings.id, bookingId));
        expect((await post(guest, bookingId, { rating: 5 })).status).toBe(409);
      },
    );

    it("explains that a confirmed stay has not finished yet", async () => {
      await db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, bookingId));
      const res = await post(guest, bookingId, { rating: 5 });
      expect((await res.json()).message).toMatch(/hasn't finished/i);
    });

    it("409s a second review of the same stay", async () => {
      expect((await post(guest, bookingId, { rating: 5 })).status).toBe(201);

      const second = await post(guest, bookingId, { rating: 1 });
      expect(second.status).toBe(409);
      expect((await second.json()).message).toMatch(/already been reviewed/i);
    });

    it("keeps only one review when two are submitted at once", async () => {
      // Both pass the status checks; the unique index is the actual guard.
      const results = await Promise.all([
        post(guest, bookingId, { rating: 5 }),
        post(guest, bookingId, { rating: 1 }),
      ]);

      expect(results.map(r => r.status).sort()).toEqual([201, 409]);
      const rows = await db.select().from(reviews).where(eq(reviews.bookingId, bookingId));
      expect(rows).toHaveLength(1);
    });

    it.each([
      ["zero", 0],
      ["six", 6],
      ["negative", -1],
      ["fractional", 3.5],
    ])("422s a rating of %s", async (_label, rating) => {
      expect((await post(guest, bookingId, { rating })).status).toBe(422);
    });

    it("422s an empty comment", async () => {
      expect((await post(guest, bookingId, { rating: 5, comment: "   " })).status).toBe(422);
    });

    it("ignores a client-supplied propertyId", async () => {
      const elsewhere = await makeProperty(admin.id, { title: "Somewhere else" });
      const res = await post(guest, bookingId, {
        rating: 5,
        propertyId: elsewhere.id,
      });

      expect(res.status).toBe(201);
      expect((await res.json()).propertyId).toBe(propertyId);
    });
  });

  describe("reading reviews", () => {
    it("is public", async () => {
      expect((await app.request(`/properties/${propertyId}/reviews`)).status).toBe(200);
    });

    it("reports no rating before the first review", async () => {
      const { summary } = await (await app.request(`/properties/${propertyId}/reviews`)).json();
      expect(summary).toEqual({ averageRating: null, count: 0 });
    });

    it("returns the reviewer's name but no identifiers", async () => {
      await post(guest, bookingId, { rating: 5, comment: "Great" });

      const { data } = await (await app.request(`/properties/${propertyId}/reviews`)).json();
      expect(data[0].guestName).toBeTruthy();
      expect(JSON.stringify(data[0])).not.toContain(guest.id);
    });

    it("averages across every review, not just the page", async () => {
      const ratings = [5, 4, 3, 2, 1];
      for (const rating of ratings) {
        const [b] = await db.insert(bookings).values({
          propertyId,
          guestId: guest.id,
          checkIn: dayFromNow(-40 - rating),
          checkOut: dayFromNow(-38 - rating),
          guestCount: 1,
          totalAmountCents: 100_000,
          status: "completed",
        }).returning();
        await post(guest, b.id, { rating });
      }

      const res = await app.request(`/properties/${propertyId}/reviews?limit=2`);
      const { data, summary, meta } = await res.json();

      expect(data).toHaveLength(2);
      expect(summary.count).toBe(5);
      expect(summary.averageRating).toBe(3);
      expect(meta.totalPages).toBe(3);
    });

    it("rounds the average to one decimal", async () => {
      for (const rating of [5, 4]) {
        const [b] = await db.insert(bookings).values({
          propertyId,
          guestId: guest.id,
          checkIn: dayFromNow(-60 - rating),
          checkOut: dayFromNow(-58 - rating),
          guestCount: 1,
          totalAmountCents: 100_000,
          status: "completed",
        }).returning();
        await post(guest, b.id, { rating });
      }

      const { summary } = await (await app.request(`/properties/${propertyId}/reviews`)).json();
      expect(summary.averageRating).toBe(4.5);
    });

    it("only counts reviews for the property asked about", async () => {
      const elsewhere = await makeProperty(admin.id, { title: "Other place" });
      await post(guest, bookingId, { rating: 5 });

      const { summary } = await (await app.request(`/properties/${elsewhere.id}/reviews`)).json();
      expect(summary.count).toBe(0);
    });

    it("404s an unknown property", async () => {
      const res = await app.request("/properties/4651e634-a530-4484-9b09-9616a28f35e3/reviews");
      expect(res.status).toBe(404);
    });
  });

  describe("completing stays", () => {
    // Nothing advanced a booking past `confirmed` before this, so `completed`
    // was unreachable and no stay could ever be reviewed.
    it("marks a finished stay completed, making it reviewable", async () => {
      const [b] = await db.insert(bookings).values({
        propertyId,
        guestId: guest.id,
        checkIn: dayFromNow(-5),
        checkOut: dayFromNow(-2),
        guestCount: 1,
        totalAmountCents: 100_000,
        status: "confirmed",
      }).returning();

      expect((await post(guest, b.id, { rating: 5 })).status).toBe(409);

      const res = await app.request("/admin/payments/reconcile", {
        method: "POST",
        headers: admin.headers,
      });
      expect((await res.json()).staysCompleted).toBeGreaterThanOrEqual(1);

      expect((await post(guest, b.id, { rating: 5 })).status).toBe(201);
    });

    it("leaves a stay that has not finished alone", async () => {
      const [b] = await db.insert(bookings).values({
        propertyId,
        guestId: guest.id,
        checkIn: dayFromNow(5),
        checkOut: dayFromNow(8),
        guestCount: 1,
        totalAmountCents: 100_000,
        status: "confirmed",
      }).returning();

      await app.request("/admin/payments/reconcile", {
        method: "POST",
        headers: admin.headers,
      });

      const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
      expect(after.status).toBe("confirmed");
    });

    it("does not complete a cancelled booking", async () => {
      const [b] = await db.insert(bookings).values({
        propertyId,
        guestId: guest.id,
        checkIn: dayFromNow(-5),
        checkOut: dayFromNow(-2),
        guestCount: 1,
        totalAmountCents: 100_000,
        status: "cancelled",
      }).returning();

      await app.request("/admin/payments/reconcile", {
        method: "POST",
        headers: admin.headers,
      });

      const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
      expect(after.status).toBe("cancelled");
    });
  });
});
