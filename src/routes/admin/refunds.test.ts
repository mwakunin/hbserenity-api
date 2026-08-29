import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db, { pool } from "@/db";
import { bookings, payments, refunds } from "@/db/schema";
import { isCheckViolation, pgConstraintName } from "@/lib/db-errors";
import { backendPid, dayFromNow, makeProperty, nextPhone, resetDb, signIn, waitForBlockedBackend } from "@/test/helpers";

describe("refunds", () => {
  let admin: TestUser;
  let guest: TestUser;
  let bookingId: string;
  let paymentId: string;

  beforeEach(async () => {
    await resetDb();
    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id);

    const [booking] = await db.insert(bookings).values({
      propertyId: property.id,
      guestId: guest.id,
      checkIn: dayFromNow(10),
      checkOut: dayFromNow(13),
      guestCount: 2,
      totalAmountCents: 2_700_000,
      status: "confirmed",
    }).returning();
    bookingId = booking.id;

    const [payment] = await db.insert(payments).values({
      bookingId,
      phoneNumber: guest.phoneNumber,
      amountCents: 2_700_000,
      status: "success",
      checkoutRequestId: "ws_CO_refund_1",
      pushDispatchedAt: new Date(),
    }).returning();
    paymentId = payment.id;
  });

  function refund(user: TestUser, body: object, id = paymentId) {
    return app.request(`/admin/payments/${id}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", ...user.headers },
      body: JSON.stringify(body),
    });
  }

  const listRefunds = (id = paymentId) =>
    app.request(`/admin/payments/${id}/refunds`, { headers: admin.headers });

  const attention = () =>
    app.request("/admin/payments/attention", { headers: admin.headers });

  describe("recording", () => {
    it("records a full refund", async () => {
      const res = await refund(admin, {
        amountCents: 2_700_000,
        reason: "Guest cancelled after payment",
        mpesaReference: "SDJ4H2K1LM",
      });

      expect(res.status).toBe(201);
      expect((await res.json()).amountCents).toBe(2_700_000);
    });

    it("403s a guest", async () => {
      const res = await refund(guest, { amountCents: 100_000, reason: "nope", mpesaReference: "REFN" });
      expect(res.status).toBe(403);
    });

    it("404s an unknown payment", async () => {
      const res = await refund(
        admin,
        { amountCents: 100_000, reason: "x", mpesaReference: "REFX" },
        "4651e634-a530-4484-9b09-9616a28f35e3",
      );
      expect(res.status).toBe(404);
    });

    // You cannot return money that was never taken.
    it.each(["pending", "failed", "timeout"] as const)(
      "409s a payment that is %s rather than successful",
      async (status) => {
        await db.update(payments).set({ status }).where(eq(payments.id, paymentId));
        const res = await refund(admin, { amountCents: 100_000, reason: "x", mpesaReference: "REFX" });
        expect(res.status).toBe(409);
      },
    );

    it("allows partial refunds that add up", async () => {
      expect((await refund(admin, { amountCents: 1_000_000, reason: "part one", mpesaReference: "REF1" })).status).toBe(201);
      expect((await refund(admin, { amountCents: 1_700_000, reason: "part two", mpesaReference: "REF2" })).status).toBe(201);

      const { refundedCents, outstandingCents } = await (await listRefunds()).json();
      expect(refundedCents).toBe(2_700_000);
      expect(outstandingCents).toBe(0);
    });

    it("409s a refund that would exceed the payment", async () => {
      await refund(admin, { amountCents: 2_000_000, reason: "part", mpesaReference: "REF3" });

      const res = await refund(admin, { amountCents: 1_000_000, reason: "too much", mpesaReference: "REF4" });
      expect(res.status).toBe(409);
      expect((await res.json()).message).toMatch(/already been returned/);
    });

    // Two refunds racing would each see the old total, so the payment lock is
    // what makes the running sum trustworthy.
    it("cannot be pushed over the total by concurrent refunds", async () => {
      const results = await Promise.all([
        refund(admin, { amountCents: 2_000_000, reason: "a", mpesaReference: "REFA" }),
        refund(admin, { amountCents: 2_000_000, reason: "b", mpesaReference: "REFB" }),
      ]);

      expect(results.map(r => r.status).sort()).toEqual([201, 409]);
      const { refundedCents } = await (await listRefunds()).json();
      expect(refundedCents).toBe(2_000_000);
    });

    // Neither test above actually proves the handler's lock is needed: two
    // app.request() calls do not interleave in-process, and an observation
    // test is satisfied by the KEY SHARE lock the refunds foreign key takes
    // anyway. So this exercises the locking semantics the handler relies on,
    // directly on two connections.
    //
    // KEY SHARE does not conflict with KEY SHARE, so the foreign key alone
    // would let two refunds read the same total and both insert. FOR UPDATE
    // is what serializes them.
    it("serializes two refunds through FOR UPDATE, which KEY SHARE would not", async () => {
      const a = await pool.connect();
      const b = await pool.connect();

      try {
        await a.query("BEGIN");
        await b.query("BEGIN");

        // What the foreign key gives for free: both succeed, so two refunds
        // could each read a stale total.
        await a.query("SELECT * FROM payments WHERE id = $1 FOR KEY SHARE", [paymentId]);
        await b.query("SELECT * FROM payments WHERE id = $1 FOR KEY SHARE", [paymentId]);

        await a.query("ROLLBACK");
        await b.query("ROLLBACK");

        // What the handler actually takes: the second waits.
        await a.query("BEGIN");
        await a.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
        const holder = (await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        let secondAcquired = false;
        const second = b.query("BEGIN")
          .then(() => b.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]))
          .then(() => {
            secondAcquired = true;
          });

        expect(await waitForBlockedBackend(holder)).toBe(true);
        expect(secondAcquired).toBe(false);

        await a.query("COMMIT");
        await second;
        expect(secondAcquired).toBe(true);
        await b.query("ROLLBACK");
      }
      finally {
        a.release();
        b.release();
      }
    });

    it("waits for a transaction holding the payment lock", async () => {
      let finished = false;
      let finishedWhileLocked: boolean | null = null;
      let writer: Promise<Response> | undefined;

      await db.transaction(async (tx) => {
        await tx.select({ id: payments.id })
          .from(payments)
          .where(eq(payments.id, paymentId))
          .for("update");

        const holder = await backendPid(tx);

        writer = Promise.resolve(
          refund(admin, { amountCents: 100_000, reason: "concurrent", mpesaReference: "REFC" }),
        ).then((r: Response) => {
          finished = true;
          return r;
        });

        expect(await waitForBlockedBackend(holder)).toBe(true);
        finishedWhileLocked = finished;
      });

      const res = await writer!;
      expect(finishedWhileLocked).toBe(false);
      expect(res.status).toBe(201);
    });

    it.each([
      ["zero", 0],
      ["negative", -100],
      ["not whole shillings", 12_345],
    ])("422s an amount that is %s", async (_label, amountCents) => {
      expect((await refund(admin, { amountCents, reason: "x", mpesaReference: "REFX" })).status).toBe(422);
    });

    // The reference is what separates a refund that happened from an
    // intention to make one — and recording one clears the payment from the
    // attention list, so an unbacked record would hide a real debt.
    it("422s a refund with no reference", async () => {
      const res = await refund(admin, {
        amountCents: 2_700_000,
        reason: "Guest cancelled",
      });
      expect(res.status).toBe(422);
    });

    it("422s an empty reference", async () => {
      const res = await refund(admin, {
        amountCents: 100_000,
        reason: "x",
        mpesaReference: "   ",
      });
      expect(res.status).toBe(422);
    });

    it("422s an empty reason", async () => {
      // A valid reference, so this fails for the reason and not for a
      // missing reference — otherwise it would pass without testing anything.
      const res = await refund(admin, {
        amountCents: 100_000,
        reason: "  ",
        mpesaReference: "REFR",
      });
      expect(res.status).toBe(422);
    });

    // NOT NULL does not stop '' or '   ', so the column being required is not
    // by itself the guarantee. This asserts the rule survives a path that
    // never runs the Zod schema — a seed script, a manual insert, a handler
    // written later.
    it("rejects a blank reference at the database, not only in Zod", async () => {
      const err = await db.insert(refunds).values({
        paymentId,
        amountCents: 100_000,
        reason: "Bypasses validation",
        mpesaReference: "   ",
        issuedBy: admin.id,
      }).then(() => undefined, (e: unknown) => e);

      expect(isCheckViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("refunds_reference_not_blank");
    });
  });

  // The whole point of allowing a paid booking to be cancelled: the money does
  // not move by itself, so it has to land somewhere a human will see it. Its
  // own describe, because the attention-list block below pre-cancels the
  // booking in beforeEach — this needs to do the cancelling itself.
  describe("cancelling a paid booking through the API", () => {
    it("puts the payment on the attention list for refund", async () => {
      const res = await app.request(`/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({ reason: "Travel plans changed" }),
      });
      expect(res.status).toBe(200);

      const { data } = await (await attention()).json();
      expect(data).toHaveLength(1);
      expect(data[0].reason).toBe("paid_but_cancelled");
      expect(data[0].amountCents).toBe(2_700_000);
    });
  });

  describe("the attention list", () => {
    beforeEach(async () => {
      // Money taken against a booking the guest cancelled — the case a refund
      // is meant to resolve.
      await db.update(bookings).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(bookings.id, bookingId));
    });

    it("flags money held against a cancelled booking", async () => {
      const { data } = await (await attention()).json();
      expect(data).toHaveLength(1);
      expect(data[0].reason).toBe("paid_but_cancelled");
    });

    it("still flags it after a partial refund", async () => {
      await refund(admin, { amountCents: 1_000_000, reason: "partial", mpesaReference: "REFP" });

      const { data } = await (await attention()).json();
      expect(data).toHaveLength(1);
    });

    // Otherwise every handled case sits there forever and the list stops
    // being worth reading.
    // An unreferenced refund cannot exist, so it cannot clear the queue —
    // this asserts the payment is still flagged after such an attempt.
    it("keeps flagging it when a refund attempt is rejected for want of a reference", async () => {
      const rejected = await refund(admin, {
        amountCents: 2_700_000,
        reason: "meant to refund but never sent",
      });
      expect(rejected.status).toBe(422);

      const { data } = await (await attention()).json();
      expect(data).toHaveLength(1);
    });

    it("stops flagging it once fully refunded", async () => {
      await refund(admin, { amountCents: 2_700_000, reason: "full refund", mpesaReference: "REFF" });

      const { data } = await (await attention()).json();
      expect(data).toEqual([]);
    });

    it("stops flagging a possible duplicate charge once refunded", async () => {
      // Clearing cancelledAt alongside: a confirmed booking carrying a
      // cancellation date is a state no code path produces, and the CHECK
      // rejects it.
      await db.update(bookings)
        .set({ status: "confirmed", cancelledAt: null })
        .where(eq(bookings.id, bookingId));
      await db.update(payments)
        .set({ resultDesc: "Prompt sent after the booking became 'confirmed' — possible duplicate charge, needs refund review" })
        .where(eq(payments.id, paymentId));

      expect((await (await attention()).json()).data).toHaveLength(1);

      await refund(admin, { amountCents: 2_700_000, reason: "duplicate charge returned", mpesaReference: "REFD" });
      expect((await (await attention()).json()).data).toEqual([]);
    });
  });

  describe("reading refunds", () => {
    it("reports what is still owed", async () => {
      await refund(admin, { amountCents: 700_000, reason: "partial", mpesaReference: "REFP" });

      const body = await (await listRefunds()).json();
      expect(body).toMatchObject({
        paymentCents: 2_700_000,
        refundedCents: 700_000,
        outstandingCents: 2_000_000,
      });
      expect(body.data).toHaveLength(1);
    });

    it("404s an unknown payment", async () => {
      const res = await listRefunds("4651e634-a530-4484-9b09-9616a28f35e3");
      expect(res.status).toBe(404);
    });
  });
});
