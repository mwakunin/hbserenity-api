import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db, { pool } from "@/db";
import { bookings, payments } from "@/db/schema";
import { sentEmails } from "@/lib/email";
import { resetTokenCache } from "@/lib/mpesa";
import { notifyBookingCancelled } from "@/lib/notifications";
import {
  dayFromNow,
  makeProperty,
  nextEmail,
  nextPhone,
  resetDb,
  signIn,
  signUpWithEmail,
} from "@/test/helpers";

/**
 * Mail sent around a payment.
 *
 * The cases that matter are the ones where sending and not sending are both
 * plausible: a booking cancelled while the money was in flight, and a sweep
 * passing over a booking that is already confirmed.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = { access_token: "tok", expires_in: "3599" };
const PUSH_OK = {
  MerchantRequestID: "mr-1",
  CheckoutRequestID: "ws_CO_notify_1",
  ResponseCode: "0",
  CustomerMessage: "Success. Request accepted for processing",
};

/** Safaricom agreeing, which the callback re-queries before believing it. */
const QUERY_PAID = { ResultCode: "0", ResultDesc: "The service request is processed successfully." };

function successCallback(checkoutRequestId: string, amountKes: number) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-1",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amountKes },
            { Name: "MpesaReceiptNumber", Value: "SDJ4H2K1LM" },
            { Name: "PhoneNumber", Value: 254712345678 },
          ],
        },
      },
    },
  };
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses)
    fn.mockResolvedValueOnce(r);
  // A fresh Response per call, not one shared object: a body can only be read
  // once, so mockResolvedValue would hand the second caller a consumed stream
  // and every later query would fail.
  fn.mockImplementation(() => Promise.resolve(jsonResponse(QUERY_PAID)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("payment notifications", () => {
  let admin: TestUser;
  let guest: TestUser;
  let propertyId: string;
  let bookingId: string;
  let totalCents: number;

  beforeEach(async () => {
    await resetDb();
    resetTokenCache();

    admin = await signIn(nextPhone(), "admin");
    const property = await makeProperty(admin.id);
    propertyId = property.id;

    // An email signup, so the guest has an address that can actually receive
    // mail. signIn() drives the phone flow, which yields a placeholder.
    guest = await signUpWithEmail(nextEmail());

    const res = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", ...guest.headers },
      body: JSON.stringify({
        propertyId,
        checkIn: dayFromNow(10),
        checkOut: dayFromNow(13),
        guestCount: 2,
      }),
    });
    const booking = await res.json();
    bookingId = booking.id;
    totalCents = booking.totalAmountCents;
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Push, then deliver Safaricom's success callback for it. */
  async function payAndConfirm() {
    mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

    await app.request(`/bookings/${bookingId}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", ...guest.headers },
      body: JSON.stringify({ phoneNumber: "0712345678" }),
    });

    return app.request("/mpesa/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(successCallback("ws_CO_notify_1", totalCents / 100)),
    });
  }

  it("sends a confirmation and a receipt once the payment is confirmed", async () => {
    const res = await payAndConfirm();
    expect(res.status).toBe(200);

    const subjects = sentEmails.map(m => m.subject);
    expect(subjects.some(s => /confirmed/i.test(s))).toBe(true);
    expect(subjects.some(s => /payment received/i.test(s))).toBe(true);
  });

  it("addresses the guest, and states the stay and the amount", async () => {
    await payAndConfirm();

    const confirmation = sentEmails.find(m => /confirmed/i.test(m.subject));
    expect(confirmation).toBeDefined();
    expect(confirmation!.to).toMatch(/@/);
    // 3 nights x 850,000c + 150,000c cleaning = KES 27,000.
    expect(confirmation!.body).toMatch(/3 nights/);
    expect(confirmation!.body).toMatch(/KES 27,000/);
    expect(confirmation!.body).toContain(bookingId);
  });

  // The guest paid, so they need the record; but the stay is not confirmed and
  // saying so would be a lie. This is the money-against-a-cancelled-booking
  // case the attention list exists for.
  it("sends a receipt but no confirmation when the booking was cancelled mid-flight", async () => {
    mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

    await app.request(`/bookings/${bookingId}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", ...guest.headers },
      body: JSON.stringify({ phoneNumber: "0712345678" }),
    });

    // The guest cancels while the prompt is still on the handset.
    await db.update(bookings)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(bookings.id, bookingId));

    sentEmails.length = 0;

    await app.request("/mpesa/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(successCallback("ws_CO_notify_1", totalCents / 100)),
    });

    const subjects = sentEmails.map(m => m.subject);
    expect(subjects.some(s => /payment received/i.test(s))).toBe(true);
    expect(subjects.some(s => /confirmed/i.test(s))).toBe(false);

    // And the booking really did stay cancelled.
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b.status).toBe("cancelled");
  });

  // Both the callback and the settlement path confirm bookings, and each is
  // idempotent. Without the "did this call move the row?" check, every
  // reconciliation sweep over a confirmed booking would mail the guest again.
  it("does not send a second confirmation when the sweep passes over it again", async () => {
    await payAndConfirm();
    const first = sentEmails.filter(m => /confirmed/i.test(m.subject)).length;
    expect(first).toBe(1);

    // Force the attempt back to a resolvable status so the sweep re-settles
    // it. The booking is already confirmed, so no transition should occur.
    //
    // Backdated past the sweep's minimum age as well: without that it skips
    // the row entirely, examines nothing, and this test passes whatever the
    // notification code does.
    await db.update(payments)
      .set({ status: "pending", createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(payments.bookingId, bookingId));

    const res = await app.request("/admin/payments/reconcile", {
      method: "POST",
      headers: admin.headers,
    });
    expect(res.status).toBe(200);
    // The sweep must actually have re-settled it, or nothing below is tested.
    const summary = await res.json();
    expect(summary.examined).toBe(1);
    expect(summary.paid).toBe(1);

    const total = sentEmails.filter(m => /confirmed/i.test(m.subject)).length;
    expect(total).toBe(1);
  });

  it("sends nothing to a guest whose only address is a phone placeholder", async () => {
    const phoneGuest = await signIn(nextPhone());

    const created = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneGuest.headers },
      body: JSON.stringify({
        propertyId,
        checkIn: dayFromNow(30),
        checkOut: dayFromNow(33),
        guestCount: 2,
      }),
    });
    const booking = await created.json();

    mockFetch(jsonResponse(TOKEN), jsonResponse({ ...PUSH_OK, CheckoutRequestID: "ws_CO_notify_2" }));
    await app.request(`/bookings/${booking.id}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneGuest.headers },
      body: JSON.stringify({}),
    });

    sentEmails.length = 0;

    await app.request("/mpesa/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(successCallback("ws_CO_notify_2", booking.totalAmountCents / 100)),
    });

    // Confirmed, and silent — the placeholder address would only bounce.
    const [b] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(b.status).toBe("confirmed");
    expect(sentEmails).toHaveLength(0);
  });

  // Safaricom retries anything that is not a 200 forever, so mail must never
  // be able to fail the callback — nor undo a payment that is already banked.
  it("still settles the payment when sending mail throws", async () => {
    const { Resend } = await import("resend");
    void Resend;

    const spy = vi.spyOn(sentEmails, "push").mockImplementation(() => {
      throw new Error("Resend is down");
    });

    try {
      const res = await payAndConfirm();

      expect(res.status).toBe(200);
      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("success");
      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(b.status).toBe("confirmed");
    }
    finally {
      spy.mockRestore();
    }
  });

  describe("cancellation", () => {
    const cancel = (id: string, body: object) =>
      app.request(`/bookings/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify(body),
      });

    it("tells the guest, and says a refund is coming when they paid", async () => {
      await payAndConfirm();
      sentEmails.length = 0;

      expect((await cancel(bookingId, { reason: "Plans changed" })).status).toBe(200);

      const mail = sentEmails.find(m => /cancelled/i.test(m.subject));
      expect(mail).toBeDefined();
      expect(mail!.body).toMatch(/Plans changed/);
      expect(mail!.body).toMatch(/arranging your refund/i);
      // Never a figure: refunds are recorded by hand, so a number here would
      // be a promise nothing is bound to.
      expect(mail!.body).toMatch(/KES 27,000/);
    });

    // Cancelling does not retract a prompt already on the guest's handset. If
    // the callback lands afterwards the charge is real, so promising there is
    // nothing to refund would tell them not to chase money they are owed.
    it("does not claim nothing was taken while a payment is still in flight", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      await app.request(`/bookings/${bookingId}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({ phoneNumber: "0712345678" }),
      });
      sentEmails.length = 0;

      // Cancelled with the prompt still unanswered.
      expect((await cancel(bookingId, {})).status).toBe(200);

      const mail = sentEmails.find(m => /cancelled/i.test(m.subject));
      expect(mail!.body).not.toMatch(/nothing to refund/i);
      expect(mail!.body).toMatch(/had not finished/i);

      // And the charge really can still arrive afterwards.
      await app.request("/mpesa/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(successCallback("ws_CO_notify_1", totalCents / 100)),
      });
      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(p.status).toBe("success");
    });

    // payments_one_pending_per_booking constrains only pending rows, so a
    // booking can hold two successful charges — that is what the duplicate
    // charge path on the attention list is for.
    it("totals every successful charge, not just the first", async () => {
      await payAndConfirm();

      // A second prompt answered after the booking was already settled.
      await db.insert(payments).values({
        bookingId,
        phoneNumber: "+254712345678",
        amountCents: totalCents,
        status: "success",
        checkoutRequestId: "ws_CO_notify_dup",
        pushDispatchedAt: new Date(),
      });
      sentEmails.length = 0;

      expect((await cancel(bookingId, { reason: "Double charged" })).status).toBe(200);

      const mail = sentEmails.find(m => /cancelled/i.test(m.subject));
      // Both attempts: KES 27,000 each.
      expect(mail!.body).toMatch(/KES 54,000/);
    });

    // Whatever state the single attempt is in, the email has to describe it
    // correctly — and must only claim nothing was taken when nothing can still
    // settle.
    it.each([
      ["pending", /had not finished/i],
      ["timeout", /had not finished/i],
      ["success", /arranging your refund/i],
      ["failed", /nothing to refund/i],
    ] as const)("describes an attempt that is %s", async (status, expected) => {
      const created = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: dayFromNow(70),
          checkOut: dayFromNow(73),
          guestCount: 2,
        }),
      });
      const booking = await created.json();

      await db.insert(payments).values({
        bookingId: booking.id,
        phoneNumber: "+254712345678",
        amountCents: booking.totalAmountCents,
        status,
        checkoutRequestId: `ws_CO_state_${status}`,
        pushDispatchedAt: new Date(),
      });
      sentEmails.length = 0;

      expect((await cancel(booking.id, { reason: "Testing" })).status).toBe(200);

      const mail = sentEmails.find(m => /cancelled/i.test(m.subject));
      expect(mail!.body).toMatch(expected);
    });

    // The states are read in ONE statement. Split across two, settlement
    // commits in the gap: an attempt that is pending for the first query and
    // success for the second is counted by neither, and the guest is told
    // nothing was taken while the charge stands against their cancelled
    // booking. Counting the reads is what stops that being reintroduced.
    it("reads every attempt in a single query, leaving no gap to settle in", async () => {
      await payAndConfirm();

      const spy = vi.spyOn(pool, "query");
      try {
        await notifyBookingCancelled(bookingId, {
          info: () => {},
          error: () => {},
        });

        const paymentReads = spy.mock.calls
          .map(call => (typeof call[0] === "string" ? call[0] : (call[0] as { text?: string })?.text ?? ""))
          .filter(text => /from "payments"/i.test(text));

        expect(paymentReads).toHaveLength(1);
      }
      finally {
        spy.mockRestore();
      }
    });

    it("says there is nothing to refund when no payment was taken", async () => {
      const created = await app.request("/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({
          propertyId,
          checkIn: dayFromNow(50),
          checkOut: dayFromNow(53),
          guestCount: 2,
        }),
      });
      const booking = await created.json();
      sentEmails.length = 0;

      expect((await cancel(booking.id, {})).status).toBe(200);

      const mail = sentEmails.find(m => /cancelled/i.test(m.subject));
      expect(mail!.body).toMatch(/nothing to refund/i);
    });
  });

  it("sends nothing at all for a failed payment", async () => {
    mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
    await app.request(`/bookings/${bookingId}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", ...guest.headers },
      body: JSON.stringify({ phoneNumber: "0712345678" }),
    });

    sentEmails.length = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ ResultCode: "1032", ResultDesc: "Request cancelled by user" }),
    ));

    await app.request("/mpesa/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Body: {
          stkCallback: {
            MerchantRequestID: "mr-1",
            CheckoutRequestID: "ws_CO_notify_1",
            ResultCode: 1032,
            ResultDesc: "Request cancelled by user",
          },
        },
      }),
    });

    expect(sentEmails).toHaveLength(0);
  });
});
