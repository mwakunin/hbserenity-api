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
const PUSH_OK = {
  MerchantRequestID: "mr-1",
  CheckoutRequestID: "ws_CO_test_1",
  ResponseCode: "0",
  CustomerMessage: "Success. Request accepted for processing",
};

function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error)
      fn.mockRejectedValueOnce(r);
    else
      fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Safaricom's callback envelope for a successful payment. */
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

function failureCallback(checkoutRequestId: string, code = 1032) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-1",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: code,
        ResultDesc: "Request cancelled by user",
      },
    },
  };
}

function postCallback(payload: unknown) {
  return app.request("/mpesa/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("payments routes", () => {
  let guest: TestUser;
  let admin: TestUser;
  let bookingId: string;
  let totalCents: number;

  beforeEach(async () => {
    await resetDb();
    resetTokenCache();

    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id);

    // 3 nights x 850,000c + 150,000c cleaning = 2,700,000c = KES 27,000
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
    const booking = await res.json();
    bookingId = booking.id;
    totalCents = booking.totalAmountCents;
  });

  afterEach(() => vi.unstubAllGlobals());

  async function pay(user: TestUser, id = bookingId, body: object = {}) {
    return app.request(`/bookings/${id}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", ...user.headers },
      body: JSON.stringify(body),
    });
  }

  describe("initiating a payment", () => {
    it("requires authentication", async () => {
      const res = await app.request(`/bookings/${bookingId}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("404s another guest's booking", async () => {
      const other = await signIn(nextPhone());
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

      const res = await pay(other);
      expect(res.status).toBe(404);
    });

    it("404s an unknown booking", async () => {
      const res = await pay(guest, "4651e634-a530-4484-9b09-9616a28f35e3");
      expect(res.status).toBe(404);
    });

    it("accepts the push and records a pending attempt", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

      const res = await pay(guest);
      expect(res.status).toBe(202);

      const body = await res.json();
      expect(body.status).toBe("pending");

      const [row] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(row.status).toBe("pending");
      expect(row.checkoutRequestId).toBe("ws_CO_test_1");
      expect(row.amountCents).toBe(totalCents);
    });

    // The callback identifies a payment by checkoutRequestId. If the guest
    // learns theirs, they can cancel the real payment and forge a success.
    it("never returns the checkoutRequestId to the client", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

      const res = await pay(guest);
      const raw = JSON.stringify(await res.json());

      expect(raw).not.toContain("ws_CO_test_1");
      expect(raw).not.toContain("checkoutRequestId");
    });

    it("charges exactly the booking total", async () => {
      const fetchMock = mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

      await pay(guest);

      const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(sent.Amount).toBe(totalCents / 100);
    });

    it("defaults to the phone number on the guest's account", async () => {
      const fetchMock = mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

      await pay(guest);

      const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(sent.PhoneNumber).toBe(guest.phoneNumber.replace("+", ""));
    });

    it("allows paying from a different number", async () => {
      const fetchMock = mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));

      await pay(guest, bookingId, { phoneNumber: "0722000333" });

      const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(sent.PhoneNumber).toBe("254722000333");
    });

    it("422s an unusable phone number", async () => {
      const res = await pay(guest, bookingId, { phoneNumber: "0812345678" });
      expect(res.status).toBe(422);
    });

    it("409s a second push while one is still in flight", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      expect((await pay(guest)).status).toBe(202);

      // Would otherwise put a second PIN prompt on the guest's handset.
      const second = await pay(guest);
      expect(second.status).toBe(409);
    });

    it("502s and records the failure when Safaricom rejects the push", async () => {
      mockFetch(
        jsonResponse(TOKEN),
        jsonResponse({ ResponseCode: "1", errorMessage: "Invalid Amount" }),
      );

      const res = await pay(guest);
      expect(res.status).toBe(502);

      // The attempt still happened, so the trail keeps it.
      const [row] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(row.status).toBe("failed");
    });

    it("502s when Safaricom is unreachable", async () => {
      mockFetch(jsonResponse(TOKEN), new Error("ECONNREFUSED"));
      expect((await pay(guest)).status).toBe(502);
    });

    it.each(["confirmed", "cancelled", "completed"] as const)(
      "409s paying a booking that is already %s",
      async (status) => {
        await db.update(bookings).set({ status }).where(eq(bookings.id, bookingId));
        const res = await pay(guest);
        expect(res.status).toBe(409);
      },
    );
  });

  describe("callback", () => {
    /** Runs a real push so a payment row with a checkoutRequestId exists. */
    async function startPayment() {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      await pay(guest);
      vi.unstubAllGlobals();
      resetTokenCache();
    }

    async function bookingStatus() {
      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      return b.status;
    }

    async function paymentRow() {
      const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      return p;
    }

    it("confirms the booking when Safaricom verifies the payment", async () => {
      await startPayment();
      mockFetch(jsonResponse(TOKEN), jsonResponse({ ResultCode: "0", ResultDesc: "ok" }));

      const res = await postCallback(successCallback("ws_CO_test_1", totalCents / 100));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });

      expect(await bookingStatus()).toBe("confirmed");
      const row = await paymentRow();
      expect(row.status).toBe("success");
      expect(row.mpesaReceiptNumber).toBe("SDJ4H2K1LM");
    });

    // The core defence: a callback is unauthenticated, so it is only a hint.
    it("refuses to confirm when Safaricom contradicts the callback", async () => {
      await startPayment();
      mockFetch(
        jsonResponse(TOKEN),
        jsonResponse({ ResultCode: "1032", ResultDesc: "Request cancelled by user" }),
      );

      const res = await postCallback(successCallback("ws_CO_test_1", totalCents / 100));
      expect(res.status).toBe(200);

      expect(await bookingStatus()).toBe("pending_payment");
      expect((await paymentRow()).status).toBe("failed");
    });

    it("refuses to confirm when the amount does not match the booking", async () => {
      await startPayment();
      mockFetch(jsonResponse(TOKEN), jsonResponse({ ResultCode: "0", ResultDesc: "ok" }));

      // "I paid one shilling, please confirm my stay."
      const res = await postCallback(successCallback("ws_CO_test_1", 1));
      expect(res.status).toBe(200);

      expect(await bookingStatus()).toBe("pending_payment");
      expect((await paymentRow()).status).toBe("failed");
    });

    it("leaves the payment pending when verification is impossible", async () => {
      await startPayment();
      mockFetch(new Error("safaricom down"));

      await postCallback(successCallback("ws_CO_test_1", totalCents / 100));

      // Fail closed: better an unsettled payment than a booking confirmed on
      // an unverifiable claim.
      expect(await bookingStatus()).toBe("pending_payment");
      expect((await paymentRow()).status).toBe("pending");
    });

    it("marks the attempt failed when the guest cancels the prompt", async () => {
      await startPayment();
      // Failures are verified with Safaricom too, not taken on trust.
      mockFetch(
        jsonResponse(TOKEN),
        jsonResponse({ ResultCode: "1032", ResultDesc: "Request cancelled by user" }),
      );

      const res = await postCallback(failureCallback("ws_CO_test_1"));
      expect(res.status).toBe(200);

      expect(await bookingStatus()).toBe("pending_payment");
      const row = await paymentRow();
      expect(row.status).toBe("failed");
      expect(row.resultCode).toBe(1032);
    });

    it("leaves a failure callback pending when Safaricom cannot be reached", async () => {
      await startPayment();
      mockFetch(new Error("safaricom down"));

      await postCallback(failureCallback("ws_CO_test_1"));

      // Fail closed both ways: an unverifiable failure must not settle the row
      // either, or a forged one could strand a payment that actually succeeded.
      expect((await paymentRow()).status).toBe("pending");
    });

    it("is idempotent — a redelivered callback confirms only once", async () => {
      await startPayment();
      mockFetch(
        jsonResponse(TOKEN),
        jsonResponse({ ResultCode: "0", ResultDesc: "ok" }),
        jsonResponse(TOKEN),
        jsonResponse({ ResultCode: "0", ResultDesc: "ok" }),
      );

      const payload = successCallback("ws_CO_test_1", totalCents / 100);
      expect((await postCallback(payload)).status).toBe(200);
      expect((await postCallback(payload)).status).toBe(200);

      expect(await bookingStatus()).toBe("confirmed");
      const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("success");
    });

    it("does not resurrect a booking cancelled while payment was in flight", async () => {
      await startPayment();
      await db.update(bookings)
        .set({ status: "cancelled" })
        .where(eq(bookings.id, bookingId));

      mockFetch(jsonResponse(TOKEN), jsonResponse({ ResultCode: "0", ResultDesc: "ok" }));
      await postCallback(successCallback("ws_CO_test_1", totalCents / 100));

      // Money arrived against a cancelled booking: recorded, not papered over.
      expect(await bookingStatus()).toBe("cancelled");
      expect((await paymentRow()).status).toBe("success");
    });

    it.each([
      ["an unknown checkout id", { Body: { stkCallback: { CheckoutRequestID: "nope", ResultCode: 0 } } }],
      ["a malformed payload", { garbage: true }],
      ["an empty body", {}],
    ])("acknowledges %s without changing anything", async (_label, payload) => {
      await startPayment();

      const res = await postCallback(payload);
      expect(res.status).toBe(200);
      expect(await bookingStatus()).toBe("pending_payment");
      expect((await paymentRow()).status).toBe("pending");
    });

    it("never answers with a non-200, which would make Safaricom retry", async () => {
      await startPayment();
      mockFetch(new Error("boom"));

      const res = await postCallback(successCallback("ws_CO_test_1", totalCents / 100));
      expect(res.status).toBe(200);
    });
  });

  describe("concurrency", () => {
    /** Answers by endpoint, so parallel calls don't depend on ordering. */
    function routedFetch(queryResult: string) {
      const fn = vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.includes("/oauth/"))
          return jsonResponse(TOKEN);
        if (u.includes("/stkpushquery/"))
          return jsonResponse({ ResultCode: queryResult, ResultDesc: "d" });
        return jsonResponse(PUSH_OK);
      });
      vi.stubGlobal("fetch", fn);
      return fn;
    }

    it("sends only one PIN prompt when two pay requests overlap", async () => {
      const fetchMock = routedFetch("0");

      const results = await Promise.all([pay(guest), pay(guest)]);
      const statuses = results.map(r => r.status).sort();

      // Otherwise the guest gets two prompts and can be charged twice.
      expect(statuses).toEqual([202, 409]);

      const pushes = fetchMock.mock.calls
        .filter(([u]) => String(u).includes("/stkpush/"));
      expect(pushes).toHaveLength(1);

      const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      expect(rows).toHaveLength(1);
    });

    it("does not let a losing callback overwrite a settled outcome", async () => {
      routedFetch("0");
      await pay(guest);
      vi.unstubAllGlobals();
      resetTokenCache();

      // Success and failure for the same checkout request, racing.
      routedFetch("0");
      await Promise.all([
        postCallback(successCallback("ws_CO_test_1", totalCents / 100)),
        postCallback(failureCallback("ws_CO_test_1")),
      ]);

      const [row] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));

      // Whichever settles first wins, but the pair must stay consistent — a
      // payment recorded failed against a confirmed booking would corrupt
      // reconciliation.
      expect(["success", "failed"]).toContain(row.status);
      if (row.status === "success")
        expect(b.status).toBe("confirmed");
      else
        expect(b.status).toBe("pending_payment");
    });
  });

  describe("forged callback resistance", () => {
    it("does not hand the callback identifier to the booking owner", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      await pay(guest);

      const res = await app.request(`/bookings/${bookingId}/payments`, {
        headers: guest.headers,
      });

      expect(JSON.stringify(await res.json())).not.toContain("ws_CO_test_1");
    });

    it("cannot be poisoned by a forged failure callback", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      await pay(guest);
      vi.unstubAllGlobals();
      resetTokenCache();

      // Attacker claims the payment failed. Safaricom says otherwise.
      mockFetch(jsonResponse(TOKEN), jsonResponse({ ResultCode: "0", ResultDesc: "ok" }));
      await postCallback(failureCallback("ws_CO_test_1"));
      vi.unstubAllGlobals();
      resetTokenCache();

      // The genuine success callback must still be able to confirm.
      mockFetch(jsonResponse(TOKEN), jsonResponse({ ResultCode: "0", ResultDesc: "ok" }));
      await postCallback(successCallback("ws_CO_test_1", totalCents / 100));

      const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(b.status).toBe("confirmed");
    });
  });

  describe("listing attempts", () => {
    it("returns the attempts for the caller's own booking", async () => {
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      await pay(guest);

      const res = await app.request(`/bookings/${bookingId}/payments`, {
        headers: guest.headers,
      });

      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data).toHaveLength(1);
    });

    it("404s another guest's booking", async () => {
      const other = await signIn(nextPhone());
      const res = await app.request(`/bookings/${bookingId}/payments`, {
        headers: other.headers,
      });
      expect(res.status).toBe(404);
    });

    it("lets an admin see any booking's attempts", async () => {
      const res = await app.request(`/bookings/${bookingId}/payments`, {
        headers: admin.headers,
      });
      expect(res.status).toBe(200);
    });

    it("keeps a row per attempt rather than overwriting", async () => {
      // First attempt fails...
      mockFetch(jsonResponse(TOKEN), jsonResponse({ ResponseCode: "1", errorMessage: "nope" }));
      await pay(guest);
      vi.unstubAllGlobals();
      resetTokenCache();

      // ...guest retries.
      mockFetch(jsonResponse(TOKEN), jsonResponse(PUSH_OK));
      await pay(guest);

      const res = await app.request(`/bookings/${bookingId}/payments`, {
        headers: guest.headers,
      });
      const { data } = await res.json();

      expect(data).toHaveLength(2);
      expect(data.map((p: { status: string }) => p.status).sort())
        .toEqual(["failed", "pending"]);
    });
  });
});
