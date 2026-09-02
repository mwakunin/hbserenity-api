import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { bookings, properties, propertyBlackouts } from "@/db/schema";
import { dayFromNow, makeProperty, nextEmail, nextPhone, resetDb, signIn, signUpWithEmail } from "@/test/helpers";

async function book(
  user: TestUser,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guestCount = 2,
) {
  return app.request("/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", ...user.headers },
    body: JSON.stringify({ propertyId, checkIn, checkOut, guestCount }),
  });
}

describe("bookings routes", () => {
  let admin: TestUser;
  let guest: TestUser;
  let propertyId: string;

  beforeEach(async () => {
    await resetDb();
    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id);
    propertyId = property.id;
  });

  describe("creating a booking", () => {
    it("requires authentication", async () => {
      const res = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          propertyId,
          checkIn: dayFromNow(10),
          checkOut: dayFromNow(13),
          guestCount: 2,
        }),
      });
      expect(res.status).toBe(401);
    });

    it("creates a booking in pending_payment", async () => {
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(13));

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.status).toBe("pending_payment");
      expect(json.guestId).toBe(guest.id);
    });

    it("404s an unknown property", async () => {
      const res = await book(
        guest,
        "4651e634-a530-4484-9b09-9616a28f35e3",
        dayFromNow(10),
        dayFromNow(13),
      );
      expect(res.status).toBe(404);
    });

    it("404s a property that is not active", async () => {
      await db.update(properties)
        .set({ status: "draft" })
        .where(eq(properties.id, propertyId));

      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(13));
      expect(res.status).toBe(404);
    });

    it("422s when check-out is not after check-in", async () => {
      const res = await book(guest, propertyId, dayFromNow(13), dayFromNow(10));
      expect(res.status).toBe(422);
    });

    it("422s a same-day check-in and check-out", async () => {
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(10));
      expect(res.status).toBe(422);
    });

    it("422s more guests than the property sleeps", async () => {
      // makeProperty sleeps 6.
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(13), 7);

      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/sleeps at most 6/);
    });

    it("accepts exactly the maximum guest count", async () => {
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(13), 6);
      expect(res.status).toBe(201);
    });

    // A shape-only regex accepts these; Postgres then rejects them as
    // "date/time field value out of range", turning bad input into a 500.
    it.each([
      ["2026-02-30", "February 30th"],
      ["2026-13-01", "month 13"],
      ["2026-04-31", "April 31st"],
      ["2027-02-29", "Feb 29 in a non-leap year"],
    ])("422s %s (%s) rather than 500ing", async (checkIn) => {
      const res = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn,
          checkOut: dayFromNow(90),
          guestCount: 2,
        }),
      });
      expect(res.status).toBe(422);
    });

    it("accepts Feb 29 in a leap year", async () => {
      const res = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: "2028-02-29",
          checkOut: "2028-03-02",
          guestCount: 2,
        }),
      });
      expect(res.status).toBe(201);
    });

    it("422s a malformed date", async () => {
      const res = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: "10/09/2026",
          checkOut: dayFromNow(13),
          guestCount: 2,
        }),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("pricing", () => {
    it("computes the total server-side from the property rate", async () => {
      // makeProperty: 850,000c/night + 150,000c cleaning. 3 nights.
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(13));
      const json = await res.json();

      expect(json.totalAmountCents).toBe(3 * 850_000 + 150_000);
    });

    it("ignores a client-supplied total", async () => {
      const res = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: dayFromNow(10),
          checkOut: dayFromNow(13),
          guestCount: 2,
          totalAmountCents: 100, // "one shilling, please"
        }),
      });

      expect(res.status).toBe(201);
      expect((await res.json()).totalAmountCents).toBe(3 * 850_000 + 150_000);
    });

    it("snapshots the price — a later rate change does not alter the booking", async () => {
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(13));
      const original = (await res.json()).totalAmountCents;

      await db.update(properties)
        .set({ pricePerNightCents: 9_999_900 })
        .where(eq(properties.id, propertyId));

      const after = await app.request(`/bookings/${(await book(
        guest,
        propertyId,
        dayFromNow(40),
        dayFromNow(41),
      ).then(r => r.json())).id}`, { headers: guest.headers });

      // The original booking is untouched by the new rate.
      const [stored] = await db.select().from(bookings).where(eq(bookings.totalAmountCents, original));
      expect(stored.totalAmountCents).toBe(original);
      expect(after.status).toBe(200);
    });

    it("always produces a whole number of shillings", async () => {
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(17));
      expect((await res.json()).totalAmountCents % 100).toBe(0);
    });
  });

  describe("overlap prevention", () => {
    it("rejects an overlapping booking with 409", async () => {
      const first = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      expect(first.status).toBe(201);

      const second = await book(guest, propertyId, dayFromNow(12), dayFromNow(18));
      expect(second.status).toBe(409);
    });

    it("rejects a booking fully contained in an existing one", async () => {
      await book(guest, propertyId, dayFromNow(10), dayFromNow(20));
      const res = await book(guest, propertyId, dayFromNow(12), dayFromNow(14));
      expect(res.status).toBe(409);
    });

    it("rejects a booking that fully contains an existing one", async () => {
      await book(guest, propertyId, dayFromNow(12), dayFromNow(14));
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(20));
      expect(res.status).toBe(409);
    });

    it("rejects an identical booking", async () => {
      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const res = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      expect(res.status).toBe(409);
    });

    it("allows back-to-back stays where check-in equals the prior check-out", async () => {
      const first = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      expect(first.status).toBe(201);

      // The 15th is checkout day — it must be immediately bookable.
      const second = await book(guest, propertyId, dayFromNow(15), dayFromNow(20));
      expect(second.status).toBe(201);
    });

    it("allows the same dates on a different property", async () => {
      const other = await makeProperty(admin.id, { title: "Another place" });

      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const res = await book(guest, other.id, dayFromNow(10), dayFromNow(15));
      expect(res.status).toBe(201);
    });

    it("frees the dates again once a booking is cancelled", async () => {
      const first = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await first.json();

      const blocked = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      expect(blocked.status).toBe(409);

      const cancelled = await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });
      expect(cancelled.status).toBe(200);

      const retry = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      expect(retry.status).toBe(201);
    });

    it("survives concurrent requests: exactly one wins, the other gets 409", async () => {
      // The real test of the constraint. Both requests pass any
      // application-level availability check; only the database can settle it.
      const results = await Promise.all([
        book(guest, propertyId, dayFromNow(30), dayFromNow(35)),
        book(guest, propertyId, dayFromNow(30), dayFromNow(35)),
      ]);

      const statuses = results.map(r => r.status).sort();
      expect(statuses).toEqual([201, 409]);
    });

    it("survives five concurrent requests for the same dates", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          book(guest, propertyId, dayFromNow(50), dayFromNow(55))),
      );

      const created = results.filter(r => r.status === 201);
      const conflicted = results.filter(r => r.status === 409);

      expect(created).toHaveLength(1);
      expect(conflicted).toHaveLength(4);
    });
  });

  describe("blackouts", () => {
    async function blackout(user: TestUser, start: string, end: string) {
      return app.request("/blackouts", {
        method: "POST",
        headers: { "content-type": "application/json", ...user.headers },
        body: JSON.stringify({ propertyId, startDate: start, endDate: end }),
      });
    }

    it("requires admin", async () => {
      const res = await blackout(guest, dayFromNow(10), dayFromNow(15));
      expect(res.status).toBe(403);
    });

    it("lets an admin block dates", async () => {
      const res = await blackout(admin, dayFromNow(10), dayFromNow(15));
      expect(res.status).toBe(201);
    });

    it("blocks a booking that overlaps a blackout", async () => {
      await blackout(admin, dayFromNow(10), dayFromNow(15));

      const res = await book(guest, propertyId, dayFromNow(12), dayFromNow(18));
      expect(res.status).toBe(409);
    });

    it("allows a booking that starts on the blackout end date", async () => {
      await blackout(admin, dayFromNow(10), dayFromNow(15));

      const res = await book(guest, propertyId, dayFromNow(15), dayFromNow(18));
      expect(res.status).toBe(201);
    });

    it("409s overlapping blackouts", async () => {
      await blackout(admin, dayFromNow(10), dayFromNow(15));
      const res = await blackout(admin, dayFromNow(12), dayFromNow(18));
      expect(res.status).toBe(409);
    });

    // The mirror of "blocks a booking that overlaps a blackout" — without it,
    // an admin could mark an already-sold stay as host-blocked.
    it("409s a blackout over an existing booking", async () => {
      const booked = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      expect(booked.status).toBe(201);

      const res = await blackout(admin, dayFromNow(12), dayFromNow(18));
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toMatch(/already booked/i);
    });

    it("409s a blackout that exactly covers a booking", async () => {
      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const res = await blackout(admin, dayFromNow(10), dayFromNow(15));
      expect(res.status).toBe(409);
    });

    it("allows a blackout starting on a booking's check-out day", async () => {
      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));

      // Half-open ranges: the 15th is free the moment the guest leaves.
      const res = await blackout(admin, dayFromNow(15), dayFromNow(18));
      expect(res.status).toBe(201);
    });

    it("allows a blackout over a cancelled booking", async () => {
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });

      const res = await blackout(admin, dayFromNow(10), dayFromNow(15));
      expect(res.status).toBe(201);
    });

    it("resolves a concurrent booking and blackout for the same dates", async () => {
      // These live in different tables, so no EXCLUDE constraint can cover the
      // pair — the property row lock is what serializes them. Exactly one must
      // win, or a sold stay ends up marked host-blocked.
      const [bookRes, blackRes] = await Promise.all([
        book(guest, propertyId, dayFromNow(70), dayFromNow(75)),
        blackout(admin, dayFromNow(70), dayFromNow(75)),
      ]);

      const outcomes = [bookRes.status, blackRes.status].sort();
      expect(outcomes).toEqual([201, 409]);
    });

    it("422s an end date before the start date", async () => {
      const res = await blackout(admin, dayFromNow(15), dayFromNow(10));
      expect(res.status).toBe(422);
    });

    describe("listing and removing", () => {
      async function listBlackouts(user: TestUser, query = "") {
        return app.request(`/blackouts${query}`, { headers: user.headers });
      }

      async function removeBlackout(user: TestUser, id: string) {
        return app.request(`/blackouts/${id}`, {
          method: "DELETE",
          headers: user.headers,
        });
      }

      it("lists them for an admin, earliest first", async () => {
        await blackout(admin, dayFromNow(20), dayFromNow(25));
        await blackout(admin, dayFromNow(10), dayFromNow(15));

        const res = await listBlackouts(admin);
        const { data, meta } = await res.json();

        expect(res.status).toBe(200);
        expect(meta.total).toBe(2);
        expect(data.map((b: { startDate: string }) => b.startDate))
          .toEqual([dayFromNow(10), dayFromNow(20)]);
      });

      // The reason is host-internal — why the owner took dates off the market
      // is nobody else's business, which is why availability does not carry it.
      it.each([
        ["a guest", 403],
        ["nobody", 401],
      ])("refuses to list them for %s", async (who, expected) => {
        const res = who === "a guest"
          ? await listBlackouts(guest)
          : await app.request("/blackouts");

        expect(res.status).toBe(expected);
      });

      it("filters by property", async () => {
        const other = await makeProperty(admin.id);
        await blackout(admin, dayFromNow(10), dayFromNow(15));
        await app.request("/blackouts", {
          method: "POST",
          headers: { "content-type": "application/json", ...admin.headers },
          body: JSON.stringify({
            propertyId: other.id,
            startDate: dayFromNow(10),
            endDate: dayFromNow(15),
          }),
        });

        const { data } = await (await listBlackouts(admin, `?propertyId=${other.id}`)).json();

        expect(data).toHaveLength(1);
        expect(data[0].propertyId).toBe(other.id);
      });

      // Overlap, not containment: the blackout a calendar most needs to show
      // is the one already running when the window opens.
      it("includes a blackout that spans the whole window", async () => {
        await blackout(admin, dayFromNow(10), dayFromNow(40));

        const { data } = await (await listBlackouts(
          admin,
          `?from=${dayFromNow(20)}&to=${dayFromNow(25)}`,
        )).json();

        expect(data).toHaveLength(1);
      });

      // Half-open at both ends, like every other range here.
      it("excludes one that ends on `from` or starts on `to`", async () => {
        await blackout(admin, dayFromNow(5), dayFromNow(20));
        await blackout(admin, dayFromNow(30), dayFromNow(35));

        const { data } = await (await listBlackouts(
          admin,
          `?from=${dayFromNow(20)}&to=${dayFromNow(30)}`,
        )).json();

        expect(data).toEqual([]);
      });

      // The whole point of the endpoint: blocking dates stops being a
      // one-way door.
      it("puts the dates back on sale when removed", async () => {
        const created = await blackout(admin, dayFromNow(10), dayFromNow(15));
        const { id } = await created.json();

        expect((await book(guest, propertyId, dayFromNow(11), dayFromNow(14))).status)
          .toBe(409);

        const removed = await removeBlackout(admin, id);
        expect(removed.status).toBe(204);

        expect((await book(guest, propertyId, dayFromNow(11), dayFromNow(14))).status)
          .toBe(201);
      });

      it("404s an unknown id", async () => {
        const res = await removeBlackout(admin, "4651e634-a530-4484-9b09-9616a28f35e3");
        expect(res.status).toBe(404);
      });

      it("forbids a guest from removing one", async () => {
        const created = await blackout(admin, dayFromNow(10), dayFromNow(15));
        const { id } = await created.json();

        const res = await removeBlackout(guest, id);
        expect(res.status).toBe(403);
      });

      /*
       * Offset pagination needs a total order. `startDate` is not unique, so
       * with it alone the database is free to return the tied rows in any
       * order per page — the same row can land on two pages while another
       * lands on none.
       *
       * The ids are fixed so the lowest is inserted LAST: without the
       * tiebreaker the pages come back in insertion order, which is the
       * reverse of what the tiebreaker gives.
       */
      it("pages tied start dates in a stable order", async () => {
        const ids = [
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ];

        // One property each: the EXCLUDE constraint forbids two blackouts
        // over the same dates on one property.
        for (const id of ids) {
          const property = await makeProperty(admin.id);
          await db.insert(propertyBlackouts).values({
            id,
            propertyId: property.id,
            startDate: dayFromNow(10),
            endDate: dayFromNow(15),
          });
        }

        const paged: string[] = [];
        for (let page = 1; page <= 3; page++) {
          const { data } = await (await listBlackouts(admin, `?page=${page}&limit=1`)).json();
          paged.push(...data.map((b: { id: string }) => b.id));
        }

        expect(paged).toEqual([...ids].sort());
        expect(new Set(paged).size).toBe(3);
      });

      // Pins the contract, not the race: two removals of one blackout must
      // report one success and one 404, never two successes. Firing them
      // together does not guarantee they overlap in the database — the
      // handler deletes and checks in a single statement so that the answer
      // holds when they do, which this cannot observe from in-process.
      it("reports one 204 and one 404 when the same blackout is removed twice", async () => {
        const created = await blackout(admin, dayFromNow(10), dayFromNow(15));
        const { id } = await created.json();

        const results = await Promise.all([
          removeBlackout(admin, id),
          removeBlackout(admin, id),
        ]);

        expect(results.map(r => r.status).sort()).toEqual([204, 404]);
      });
    });
  });

  describe("availability", () => {
    it("is public", async () => {
      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(0)}&to=${dayFromNow(60)}`,
      );
      expect(res.status).toBe(200);
    });

    it("reports nothing unavailable on an empty calendar", async () => {
      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(0)}&to=${dayFromNow(60)}`,
      );
      expect((await res.json()).unavailable).toEqual([]);
    });

    it("reports a booking as unavailable", async () => {
      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));

      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(0)}&to=${dayFromNow(60)}`,
      );
      const { unavailable } = await res.json();

      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]).toMatchObject({
        start: dayFromNow(10),
        end: dayFromNow(15),
        reason: "booked",
      });
    });

    it("reports blackouts alongside bookings", async () => {
      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      await app.request("/blackouts", {
        method: "POST",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({
          propertyId,
          startDate: dayFromNow(20),
          endDate: dayFromNow(25),
        }),
      });

      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(0)}&to=${dayFromNow(60)}`,
      );
      const { unavailable } = await res.json();

      expect(unavailable).toHaveLength(2);
      expect(unavailable.map((u: { reason: string }) => u.reason))
        .toEqual(["booked", "blackout"]);
    });

    it("excludes a cancelled booking", async () => {
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });

      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(0)}&to=${dayFromNow(60)}`,
      );
      expect((await res.json()).unavailable).toEqual([]);
    });

    it("excludes bookings outside the requested window", async () => {
      await book(guest, propertyId, dayFromNow(50), dayFromNow(55));

      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(0)}&to=${dayFromNow(20)}`,
      );
      expect((await res.json()).unavailable).toEqual([]);
    });

    it("404s an unknown property", async () => {
      const res = await app.request(
        `/properties/4651e634-a530-4484-9b09-9616a28f35e3/availability?from=${dayFromNow(0)}&to=${dayFromNow(60)}`,
      );
      expect(res.status).toBe(404);
    });

    it("422s an inverted window rather than reporting everything free", async () => {
      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(60)}&to=${dayFromNow(10)}`,
      );
      expect(res.status).toBe(422);
    });

    it("422s a zero-length window", async () => {
      const res = await app.request(
        `/properties/${propertyId}/availability?from=${dayFromNow(10)}&to=${dayFromNow(10)}`,
      );
      expect(res.status).toBe(422);
    });

    it("422s an impossible calendar date in the window", async () => {
      const res = await app.request(
        `/properties/${propertyId}/availability?from=2026-02-30&to=2026-03-10`,
      );
      expect(res.status).toBe(422);
    });
  });

  describe("listing and access control", () => {
    it("shows a guest only their own bookings", async () => {
      const other = await signIn(nextPhone());

      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      await book(other, propertyId, dayFromNow(20), dayFromNow(25));

      const res = await app.request("/bookings", { headers: guest.headers });
      const { data } = await res.json();

      expect(data).toHaveLength(1);
      expect(data[0].guestId).toBe(guest.id);
    });

    it("shows an admin every booking", async () => {
      const other = await signIn(nextPhone());

      await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      await book(other, propertyId, dayFromNow(20), dayFromNow(25));

      const res = await app.request("/bookings", { headers: admin.headers });
      expect((await res.json()).data).toHaveLength(2);
    });

    // Without this a dashboard can only print a uuid, or fetch a user per
    // row to turn it into a name. `GET /properties/{id}/reviews` already
    // joins for exactly this reason.
    it("carries the guest's name", async () => {
      const named = await signUpWithEmail(
        nextEmail(),
        "correct-horse-battery",
        "Amina Wanjiru",
      );
      await book(named, propertyId, dayFromNow(10), dayFromNow(15));

      const res = await app.request("/bookings", { headers: admin.headers });
      const { data } = await res.json();

      expect(data[0].guestName).toBe("Amina Wanjiru");
    });

    it("carries it on a guest's own list too", async () => {
      const named = await signUpWithEmail(
        nextEmail(),
        "correct-horse-battery",
        "Otieno Odhiambo",
      );
      await book(named, propertyId, dayFromNow(10), dayFromNow(15));

      const res = await app.request("/bookings", { headers: named.headers });
      const { data } = await res.json();

      expect(data[0].guestName).toBe("Otieno Odhiambo");
    });

    // The display name is all this endpoint needs. An email and a phone
    // number sit on the same row and must not ride along with it.
    it("carries the name only, not the guest's contact details", async () => {
      const email = nextEmail();
      const named = await signUpWithEmail(email, "correct-horse-battery", "Amina Wanjiru");
      await book(named, propertyId, dayFromNow(10), dayFromNow(15));

      const res = await app.request("/bookings", { headers: admin.headers });
      const body = await res.text();

      expect(body).toContain("Amina Wanjiru");
      expect(body).not.toContain(email);
      expect(JSON.parse(body).data[0]).not.toHaveProperty("email");
      expect(JSON.parse(body).data[0]).not.toHaveProperty("phoneNumber");
    });

    it("filters by status", async () => {
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();
      await book(guest, propertyId, dayFromNow(20), dayFromNow(25));

      await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });

      const res = await app.request("/bookings?status=cancelled", {
        headers: guest.headers,
      });
      expect((await res.json()).data).toHaveLength(1);
    });

    it("404s another guest's booking rather than 403", async () => {
      const other = await signIn(nextPhone());
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      const res = await app.request(`/bookings/${id}`, { headers: other.headers });
      expect(res.status).toBe(404);
    });

    it("lets an admin read any booking", async () => {
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      const res = await app.request(`/bookings/${id}`, { headers: admin.headers });
      expect(res.status).toBe(200);
    });
  });

  describe("cancellation lifecycle", () => {
    it("cancels a pending_payment booking", async () => {
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      const res = await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("cancelled");
    });

    it.each(["completed", "cancelled"] as const)(
      "409s cancelling a booking that is already %s",
      async (status) => {
        const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
        const { id } = await created.json();

        await db.update(bookings)
          .set({ status, cancelledAt: status === "cancelled" ? new Date() : null })
          .where(eq(bookings.id, id));

        const res = await app.request(`/bookings/${id}/cancel`, {
          method: "POST",
          headers: guest.headers,
        });
        expect(res.status).toBe(409);
      },
    );

    it("404s cancelling another guest's booking", async () => {
      const other = await signIn(nextPhone());
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      const res = await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: other.headers,
      });
      expect(res.status).toBe(404);
    });

    it("is idempotent-safe: a second cancel returns 409, not another success", async () => {
      const created = await book(guest, propertyId, dayFromNow(10), dayFromNow(15));
      const { id } = await created.json();

      const first = await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });
      const second = await app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: guest.headers,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
    });
  });

  // A paid stay that can never be called off is not a real product: plans
  // change on both sides, and until this existed the only way out was editing
  // the database by hand.
  describe("cancelling a confirmed booking", () => {
    async function confirmed(checkIn = dayFromNow(10), checkOut = dayFromNow(15)) {
      const created = await book(guest, propertyId, checkIn, checkOut);
      const { id } = await created.json();
      await db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, id));
      return id as string;
    }

    const cancel = (user: TestUser, id: string, body?: object) =>
      app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", ...user.headers },
        body: JSON.stringify(body ?? {}),
      });

    it("lets the guest cancel, recording who and when", async () => {
      const id = await confirmed();

      const res = await cancel(guest, id, { reason: "Travel plans changed" });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
      expect(row.status).toBe("cancelled");
      expect(row.cancellationReason).toBe("Travel plans changed");
      expect(row.cancelledBy).toBe(guest.id);
      expect(row.cancelledAt).toBeInstanceOf(Date);
    });

    it("lets an admin cancel someone else's stay", async () => {
      const id = await confirmed();

      const res = await cancel(admin, id, { reason: "Burst pipe in the unit" });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
      expect(row.cancelledBy).toBe(admin.id);
    });

    // Taking away a stay someone paid for is the case that gets argued about
    // later, so it does not go on the record unexplained.
    it("422s cancelling a paid stay with no reason", async () => {
      const id = await confirmed();

      const res = await cancel(guest, id);
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/reason is required/i);

      const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
      expect(row.status).toBe("confirmed");
    });

    // An unpaid hold is nobody's loss.
    it("still cancels an unpaid booking with no reason", async () => {
      const created = await book(guest, propertyId, dayFromNow(20), dayFromNow(22));
      const { id } = await created.json();

      expect((await cancel(guest, id)).status).toBe(200);
    });

    // The nights have to go back on sale, or cancelling achieves nothing.
    it("frees the dates for another guest", async () => {
      const id = await confirmed(dayFromNow(40), dayFromNow(45));

      const blocked = await book(guest, propertyId, dayFromNow(40), dayFromNow(45));
      expect(blocked.status).toBe(409);

      await cancel(guest, id, { reason: "Changed my mind" });

      const after = await book(guest, propertyId, dayFromNow(40), dayFromNow(45));
      expect(after.status).toBe(201);
    });

    // Cancelling a stay that has begun would free nights already slept in, and
    // drop the booking out of the sweep that makes a finished stay reviewable.
    it.each([
      ["today", 0],
      ["yesterday", -1],
    ])("409s once the stay has begun (check-in %s)", async (_label, offset) => {
      const created = await book(guest, propertyId, dayFromNow(60), dayFromNow(65));
      const { id } = await created.json();
      await db.update(bookings)
        .set({
          status: "confirmed",
          checkIn: dayFromNow(offset),
          checkOut: dayFromNow(offset + 5),
        })
        .where(eq(bookings.id, id));

      const res = await cancel(guest, id, { reason: "Too late" });
      expect(res.status).toBe(409);
      expect((await res.json()).message).toMatch(/already begun/i);
    });

    it("404s a guest cancelling someone else's confirmed stay", async () => {
      const id = await confirmed();
      const other = await signIn(nextPhone());

      expect((await cancel(other, id, { reason: "not mine" })).status).toBe(404);
    });
  });
});
