import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { bookings, payments } from "@/db/schema";
import { resetTokenCache } from "@/lib/mpesa";
import { dayFromNow, makeProperty, nextPhone, resetDb, signIn } from "@/test/helpers";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = { access_token: "tok", expires_in: "3599" };

/** Answers by endpoint so the sweep's call order doesn't matter. */
function mockDaraja(queryResult: string | Error) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("/oauth/"))
      return jsonResponse(TOKEN);
    if (queryResult instanceof Error)
      throw queryResult;
    return jsonResponse({ ResultCode: queryResult, ResultDesc: "d" });
  }));
}

/** Older than the sweep's minimum age, so it is actually considered. */
const OLD = () => new Date(Date.now() - 10 * 60 * 1000);

describe("admin payment reconciliation", () => {
  let admin: TestUser;
  let guest: TestUser;
  let bookingId: string;

  beforeEach(async () => {
    await resetDb();
    resetTokenCache();

    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id);

    const res = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", ...guest.headers },
      body: JSON.stringify({
        propertyId: property.id,
        checkIn: dayFromNow(10),
        checkOut: dayFromNow(13),
        guestCount: 2,
      }),
    });
    bookingId = (await res.json()).id;
  });

  afterEach(() => vi.unstubAllGlobals());

  /** A pending attempt as the payment flow would leave one. */
  async function pendingAttempt(overrides: Partial<typeof payments.$inferInsert> = {}) {
    const [row] = await db.insert(payments).values({
      bookingId,
      phoneNumber: guest.phoneNumber,
      amountCents: 2_700_000,
      checkoutRequestId: "ws_CO_recon_1",
      pushDispatchedAt: OLD(),
      createdAt: OLD(),
      ...overrides,
    }).returning();
    return row;
  }

  const runSweep = () =>
    app.request("/admin/payments/reconcile", { method: "POST", headers: admin.headers });

  const listAttention = () =>
    app.request("/admin/payments/attention", { headers: admin.headers });

  describe("authorization", () => {
    it("401s the sweep when anonymous", async () => {
      const res = await app.request("/admin/payments/reconcile", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("403s the sweep for a guest", async () => {
      const res = await app.request("/admin/payments/reconcile", {
        method: "POST",
        headers: guest.headers,
      });
      expect(res.status).toBe(403);
    });

    it("403s the attention list for a guest", async () => {
      const res = await app.request("/admin/payments/attention", {
        headers: guest.headers,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("sweeping", () => {
    // The whole reason this exists: the guest paid, the callback never
    // arrived, and without a sweep their booking never confirms.
    it("confirms a booking whose callback was lost", async () => {
      await pendingAttempt();
      mockDaraja("0");

      const res = await runSweep();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ examined: 1, paid: 1 });

      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(b.status).toBe("confirmed");
      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("success");
    });

    it("frees a booking whose payment terminally failed", async () => {
      await pendingAttempt();
      mockDaraja("1032");

      expect(await (await runSweep()).json()).toMatchObject({ failed: 1 });

      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("failed");
      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(b.status).toBe("pending_payment");
    });

    it("leaves an attempt alone while Safaricom is still processing it", async () => {
      await pendingAttempt();
      mockDaraja("1001");

      expect(await (await runSweep()).json()).toMatchObject({ unresolved: 1 });

      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("pending");
    });

    it("leaves an attempt alone when Safaricom is unreachable", async () => {
      await pendingAttempt();
      mockDaraja(new Error("down"));

      expect(await (await runSweep()).json()).toMatchObject({ unresolved: 1 });

      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("pending");
    });

    it("ignores attempts too young to have missed their callback", async () => {
      await pendingAttempt({ createdAt: new Date() });
      mockDaraja("0");

      expect(await (await runSweep()).json()).toMatchObject({ examined: 0 });
    });

    it("is idempotent — a second sweep settles nothing further", async () => {
      await pendingAttempt();
      mockDaraja("0");

      await runSweep();
      const second = await runSweep();

      expect(await second.json()).toMatchObject({ examined: 0, paid: 0 });
      const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("success");
    });

    it("does not resurrect a booking the guest cancelled", async () => {
      await pendingAttempt();
      await db.update(bookings).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(bookings.id, bookingId));
      mockDaraja("0");

      await runSweep();

      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(b.status).toBe("cancelled");
      // The money is still recorded — it is a refund case, not a silent drop.
      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("success");
    });

    it("releases an attempt that never got as far as a push", async () => {
      await pendingAttempt({ checkoutRequestId: null, pushDispatchedAt: null });
      mockDaraja("0");

      expect(await (await runSweep()).json()).toMatchObject({ releasedUndispatched: 1 });

      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("timeout");
    });

    it("does not release an attempt whose push was dispatched", async () => {
      await pendingAttempt({ checkoutRequestId: null });
      mockDaraja("0");

      // No reference to query, and a prompt may be live — must stay held.
      expect(await (await runSweep()).json()).toMatchObject({ releasedUndispatched: 0 });

      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("pending");
    });
  });

  describe("concurrent settlement", () => {
    // A callback or a second runner can settle an attempt mid-sweep. Counting
    // that as this pass's own work would report a settlement it didn't make.
    it("reports a lost race as alreadySettled, not paid", async () => {
      await pendingAttempt();

      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes("/oauth/"))
          return jsonResponse(TOKEN);
        // Settle it behind the sweep's back, between query and write.
        await db.update(payments)
          .set({ status: "failed", resultDesc: "settled elsewhere" })
          .where(eq(payments.bookingId, bookingId));
        return jsonResponse({ ResultCode: "0", ResultDesc: "ok" });
      }));

      const summary = await (await runSweep()).json();

      expect(summary).toMatchObject({ examined: 1, paid: 0, alreadySettled: 1 });

      // The winner's outcome stands.
      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("failed");
      expect(p.resultDesc).toBe("settled elsewhere");
    });

    it("does not report a lost race as failed either", async () => {
      await pendingAttempt();

      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes("/oauth/"))
          return jsonResponse(TOKEN);
        await db.update(payments)
          .set({ status: "success" })
          .where(eq(payments.bookingId, bookingId));
        return jsonResponse({ ResultCode: "1032", ResultDesc: "cancelled" });
      }));

      const summary = await (await runSweep()).json();
      expect(summary).toMatchObject({ failed: 0, alreadySettled: 1 });

      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("success");
    });
  });

  describe("aged timeout attempts", () => {
    // `timeout` means we stopped waiting, not that Safaricom ruled — so one
    // with a reference must still be swept, exactly as a late callback could
    // still settle it.
    it("sweeps an aged timeout attempt that still has a reference", async () => {
      await pendingAttempt({ status: "timeout" });
      mockDaraja("0");

      const summary = await (await runSweep()).json();
      expect(summary).toMatchObject({ examined: 1, paid: 1 });

      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(b.status).toBe("confirmed");
    });

    it("surfaces an aged timeout attempt for manual review", async () => {
      await pendingAttempt({
        status: "timeout",
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      });

      const { data } = await (await listAttention()).json();
      expect(data).toHaveLength(1);
      expect(data[0].reason).toBe("stuck_pending");
    });
  });

  describe("needing attention", () => {
    it("is empty when nothing is stuck", async () => {
      const res = await listAttention();
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });

    it("reports a push dispatched without a reference", async () => {
      await pendingAttempt({ checkoutRequestId: null });

      const { data } = await (await listAttention()).json();
      expect(data).toHaveLength(1);
      expect(data[0].reason).toBe("dispatched_without_reference");
    });

    it("reports a possible duplicate charge", async () => {
      await pendingAttempt({
        checkoutRequestId: null,
        pushDispatchedAt: null,
        resultDesc: "Prompt sent after the booking became 'confirmed' — possible duplicate charge, needs refund review",
      });

      const { data } = await (await listAttention()).json();
      expect(data[0].reason).toBe("possible_duplicate_charge");
    });

    it("reports money received against a cancelled booking", async () => {
      await pendingAttempt({ status: "success" });
      await db.update(bookings).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(bookings.id, bookingId));

      const { data } = await (await listAttention()).json();
      expect(data[0].reason).toBe("paid_but_cancelled");
      expect(data[0].amountCents).toBe(2_700_000);
    });

    it("reports an attempt stuck pending far too long", async () => {
      await pendingAttempt({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });

      const { data } = await (await listAttention()).json();
      expect(data[0].reason).toBe("stuck_pending");
    });

    it("clears once the sweep settles the attempt", async () => {
      await pendingAttempt({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
      expect((await (await listAttention()).json()).data).toHaveLength(1);

      mockDaraja("0");
      await runSweep();

      expect((await (await listAttention()).json()).data).toEqual([]);
    });
  });
});
