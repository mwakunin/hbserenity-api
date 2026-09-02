import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { bookings, payments, refunds } from "@/db/schema";
import { dayFromNow, makeProperty, nextPhone, resetDb, signIn } from "@/test/helpers";

describe("admin payments list", () => {
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

  let dayOffset = 0;

  /** A booking with one attempt against it, in whatever state is being tested. */
  async function attempt(
    amountCents: number,
    status: "pending" | "success" | "failed" | "timeout",
    createdAt?: Date,
  ) {
    dayOffset += 4;
    const [booking] = await db.insert(bookings).values({
      propertyId,
      guestId: guest.id,
      checkIn: dayFromNow(dayOffset),
      checkOut: dayFromNow(dayOffset + 2),
      guestCount: 2,
      totalAmountCents: amountCents,
      status: status === "success" ? "confirmed" : "pending_payment",
    }).returning();

    const [payment] = await db.insert(payments).values({
      bookingId: booking.id,
      phoneNumber: guest.phoneNumber,
      amountCents,
      status,
      // Never returned by any endpoint; set so the row is realistic.
      checkoutRequestId: `ws_CO_${booking.id.slice(0, 8)}`,
      merchantRequestId: `mr_${booking.id.slice(0, 8)}`,
      pushDispatchedAt: new Date(),
      ...(createdAt ? { createdAt } : {}),
    }).returning();

    return { bookingId: booking.id, paymentId: payment.id };
  }

  async function refund(paymentId: string, amountCents: number) {
    await db.insert(refunds).values({
      paymentId,
      amountCents,
      reason: "Guest cancelled after payment",
      mpesaReference: `REF${amountCents}`,
      issuedBy: admin.id,
    });
  }

  const list = (query = "", as: TestUser = admin) =>
    app.request(`/admin/payments${query}`, { headers: as.headers });

  describe("access", () => {
    it("is admin only", async () => {
      expect((await list("", guest)).status).toBe(403);
      expect((await app.request("/admin/payments")).status).toBe(401);
    });
  });

  describe("the money", () => {
    // The whole reason for the endpoint: totalling what was actually taken
    // needed a request per booking before it.
    it("totals only successful attempts", async () => {
      await attempt(1_000_000, "success");
      await attempt(2_000_000, "success");
      await attempt(4_000_000, "pending");
      await attempt(8_000_000, "failed");
      await attempt(16_000_000, "timeout");

      const { totals, meta } = await (await list()).json();

      expect(totals.receivedCents).toBe(3_000_000);
      expect(totals.refundedCents).toBe(0);
      expect(totals.netCents).toBe(3_000_000);
      // Every attempt is still listed — only the money is restricted.
      expect(meta.total).toBe(5);
    });

    it("nets refunds off what was received", async () => {
      const { paymentId } = await attempt(2_000_000, "success");
      await refund(paymentId, 500_000);

      const { totals } = await (await list()).json();

      expect(totals.receivedCents).toBe(2_000_000);
      expect(totals.refundedCents).toBe(500_000);
      expect(totals.netCents).toBe(1_500_000);
    });

    // A payment can be refunded more than once. Joining refunds to payments in
    // the same query would repeat the payment and double its own amount.
    it("counts a twice-refunded payment once", async () => {
      const { paymentId } = await attempt(2_000_000, "success");
      await refund(paymentId, 300_000);
      await refund(paymentId, 400_000);

      const { data, totals, meta } = await (await list()).json();

      expect(meta.total).toBe(1);
      expect(totals.receivedCents).toBe(2_000_000);
      expect(totals.refundedCents).toBe(700_000);
      expect(data[0].refundedCents).toBe(700_000);
    });

    // Totalling the page would report a different figure per page.
    it("totals every match, not the page", async () => {
      for (let i = 0; i < 3; i++)
        await attempt(1_000_000, "success");

      const { data, totals, meta } = await (await list("?limit=1")).json();

      expect(data).toHaveLength(1);
      expect(meta.total).toBe(3);
      expect(totals.receivedCents).toBe(3_000_000);
    });
  });

  describe("filters", () => {
    it("filters by status", async () => {
      await attempt(1_000_000, "success");
      await attempt(2_000_000, "failed");

      const { data, totals } = await (await list("?status=failed")).json();

      expect(data).toHaveLength(1);
      expect(data[0].status).toBe("failed");
      // A failed attempt is not money, so the total stays zero.
      expect(totals.receivedCents).toBe(0);
    });

    it("filters by booking", async () => {
      const first = await attempt(1_000_000, "success");
      await attempt(2_000_000, "success");

      const { data, totals } = await (await list(`?bookingId=${first.bookingId}`)).json();

      expect(data).toHaveLength(1);
      expect(totals.receivedCents).toBe(1_000_000);
    });

    /*
     * The window is Kenyan calendar days, half-open.
     *
     * 20:59:59Z on the 31st is still August in Nairobi; 21:00:00Z is already
     * the 1st. Bounded in UTC these two land in the same day, so a September
     * total would include money taken in August.
     */
    it("bounds the window by Kenyan days, not UTC ones", async () => {
      await attempt(1_000_000, "success", new Date("2026-08-31T20:59:59Z"));
      await attempt(2_000_000, "success", new Date("2026-08-31T21:00:00Z"));
      await attempt(4_000_000, "success", new Date("2026-09-30T20:59:59Z"));
      await attempt(8_000_000, "success", new Date("2026-09-30T21:00:00Z"));

      const { totals, meta } = await (await list("?from=2026-09-01&to=2026-10-01")).json();

      // The middle two only: the first is still August in Nairobi and the
      // last is already October.
      expect(meta.total).toBe(2);
      expect(totals.receivedCents).toBe(6_000_000);
    });

    it("accepts an open-ended window", async () => {
      await attempt(1_000_000, "success", new Date("2026-08-15T09:00:00Z"));
      await attempt(2_000_000, "success", new Date("2026-09-15T09:00:00Z"));

      const since = await (await list("?from=2026-09-01")).json();
      const until = await (await list("?to=2026-09-01")).json();

      expect(since.totals.receivedCents).toBe(2_000_000);
      expect(until.totals.receivedCents).toBe(1_000_000);
    });

    it("422s a window that ends before it starts", async () => {
      const res = await list("?from=2026-10-01&to=2026-09-01");
      expect(res.status).toBe(422);
    });
  });

  describe("what it must never return", () => {
    /*
     * The correlation ids are all an unauthenticated M-Pesa callback needs to
     * identify an attempt. Handing one out lets a guest start a real push,
     * cancel it, and forge a result for it — so this asserts on the whole
     * body, not on named fields, which is the only way to catch a column
     * added to the table later.
     */
    it("never returns the M-Pesa correlation ids", async () => {
      const { paymentId } = await attempt(2_000_000, "success");
      const [row] = await db.select().from(payments);

      const body = await (await list()).text();

      expect(body).toContain(paymentId);
      expect(row.checkoutRequestId).toBeTruthy();
      expect(body).not.toContain(row.checkoutRequestId!);
      expect(body).not.toContain(row.merchantRequestId!);
      expect(body).not.toMatch(/checkoutRequestId|merchantRequestId/i);
    });
  });

  describe("consistency", () => {
    /*
     * The page, the count-and-received total, and the refunds against that
     * same set are three separate reads. Under READ COMMITTED each takes its
     * own snapshot: a refund committing between the first and the third makes
     * a row report itself unrefunded while `totals` counts that refund, and
     * an attempt settling between the first and the second changes
     * `receivedCents` without changing the page it summarises.
     *
     * Neither test below can observe the gap itself — that needs a commit
     * landing between two statements inside the handler, which nothing
     * in-process can schedule. Together they pin the two halves that can be
     * checked: that the handler asks for one snapshot, and that asking for it
     * is a request Postgres honours.
     */
    it("reads all three queries inside one repeatable-read snapshot", async () => {
      await attempt(1_000_000, "success");

      const spy = vi.spyOn(db, "transaction");
      try {
        expect((await list()).status).toBe(200);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toEqual({
          isolationLevel: "repeatable read",
          accessMode: "read only",
        });
      }
      finally {
        spy.mockRestore();
      }
    });

    // The option above is only worth asserting if it reaches the database.
    // A drizzle upgrade that quietly stopped applying it would leave the
    // handler reading three snapshots again while still looking correct.
    it("actually opens the transaction Postgres was asked for", async () => {
      const seen = await db.transaction(
        async (tx) => {
          const result = await tx.execute(sql`
            select current_setting('transaction_isolation') as iso,
                   current_setting('transaction_read_only') as read_only
          `);
          return result.rows[0] as { iso: string; read_only: string };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );

      expect(seen.iso).toBe("repeatable read");
      expect(seen.read_only).toBe("on");
    });
  });

  describe("ordering", () => {
    it("is newest first, and stable across pages when timestamps tie", async () => {
      const shared = new Date("2026-09-15T09:00:00Z");
      await attempt(1_000_000, "success", shared);
      await attempt(2_000_000, "success", shared);
      await attempt(4_000_000, "success", shared);

      const seen: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const { data } = await (await list(`?page=${page}&limit=1`)).json();
        seen.push(...data.map((p: { id: string }) => p.id));
      }

      expect(new Set(seen).size).toBe(3);
    });
  });
});
