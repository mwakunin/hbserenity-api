import { and, desc, eq, gt } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, payments } from "@/db/schema";
import {
  isAllowedCallbackIp,
  MpesaError,
  parseCallback,
  queryStkStatus,
  stkPush,
} from "@/lib/mpesa";
import { normalizeKenyanPhone } from "@/lib/phone";

import type {
  CallbackRoute,
  InitiateRoute,
  ListForBookingRoute,
} from "./payments.routes";

/** Safaricom retries anything that isn't this, so it is the only reply we send. */
const ACK = { ResultCode: 0, ResultDesc: "Accepted" } as const;

/**
 * How long a pending push blocks another attempt. Safaricom's prompt expires
 * after roughly a minute; re-pushing before that would put a second PIN prompt
 * on the guest's handset for the same booking.
 */
const PUSH_COOLDOWN_MS = 90_000;

export const initiate: AppRouteHandler<InitiateRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { phoneNumber } = c.req.valid("json");
  const user = c.var.user!;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, id));

  // 404 rather than 403 for someone else's booking — consistent with the
  // bookings routes, and it stops ids being probed.
  if (!booking || (user.role !== "admin" && booking.guestId !== user.id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (booking.status !== "pending_payment") {
    return c.json(
      { message: `A booking with status '${booking.status}' cannot be paid for` },
      HttpStatusCodes.CONFLICT,
    );
  }

  const payFrom = normalizeKenyanPhone(phoneNumber ?? user.phoneNumber ?? "");
  if (!payFrom) {
    return c.json(
      {
        success: false,
        error: {
          issues: [{
            code: "custom",
            path: ["phoneNumber"],
            message: "A valid Kenyan M-Pesa number is required to pay",
          }],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  // Don't stack PIN prompts on the guest's handset.
  const [inFlight] = await db.select({ id: payments.id })
    .from(payments)
    .where(and(
      eq(payments.bookingId, booking.id),
      eq(payments.status, "pending"),
      gt(payments.createdAt, new Date(Date.now() - PUSH_COOLDOWN_MS)),
    ));

  if (inFlight) {
    return c.json(
      { message: "A payment prompt was already sent. Check your phone, or wait a moment before retrying." },
      HttpStatusCodes.CONFLICT,
    );
  }

  // A new row per attempt — payment history is append-only, so a retry never
  // overwrites the record of a previous failure.
  const [payment] = await db.insert(payments).values({
    bookingId: booking.id,
    phoneNumber: payFrom,
    amountCents: booking.totalAmountCents,
  }).returning();

  try {
    const push = await stkPush({
      phoneNumber: payFrom,
      amountCents: booking.totalAmountCents,
      accountReference: booking.id.slice(0, 8),
      description: "Rental booking",
    });

    await db.update(payments)
      .set({
        checkoutRequestId: push.checkoutRequestId,
        merchantRequestId: push.merchantRequestId,
      })
      .where(eq(payments.id, payment.id));

    return c.json({
      paymentId: payment.id,
      status: "pending" as const,
      customerMessage: push.customerMessage
        || "A payment request has been sent to your phone.",
    }, HttpStatusCodes.ACCEPTED);
  }
  catch (err) {
    // The attempt happened and failed; keep the row so the trail is complete.
    await db.update(payments)
      .set({
        status: "failed",
        resultDesc: err instanceof MpesaError ? err.message : "STK push failed",
      })
      .where(eq(payments.id, payment.id));

    c.var.logger.error({ err, bookingId: booking.id }, "M-Pesa STK push failed");

    return c.json(
      { message: "Could not reach M-Pesa. Please try again shortly." },
      HttpStatusCodes.BAD_GATEWAY,
    );
  }
};

export const callback: AppRouteHandler<CallbackRoute> = async (c) => {
  const log = c.var.logger;

  // Safaricom does not sign callbacks, so nothing here is trusted. Every exit
  // below still returns ACK: a non-200 just makes Safaricom retry, and a
  // forged request should learn nothing from the response either way.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim()
    ?? c.req.header("x-real-ip");

  if (!isAllowedCallbackIp(ip)) {
    log.warn({ ip }, "M-Pesa callback from a non-allowlisted address; ignored");
    return c.json(ACK, HttpStatusCodes.OK);
  }

  const parsed = parseCallback(c.req.valid("json"));
  if (!parsed) {
    log.warn("M-Pesa callback could not be parsed; ignored");
    return c.json(ACK, HttpStatusCodes.OK);
  }

  const [payment] = await db.select().from(payments).where(eq(payments.checkoutRequestId, parsed.checkoutRequestId));

  if (!payment) {
    log.warn(
      { checkoutRequestId: parsed.checkoutRequestId },
      "M-Pesa callback for an unknown checkout request; ignored",
    );
    return c.json(ACK, HttpStatusCodes.OK);
  }

  // Idempotency: Safaricom re-delivers, and a settled attempt must never be
  // reopened — otherwise a replayed callback could re-confirm a cancelled
  // booking.
  if (payment.status !== "pending") {
    log.info(
      { paymentId: payment.id, status: payment.status },
      "M-Pesa callback for an already-settled payment; ignored",
    );
    return c.json(ACK, HttpStatusCodes.OK);
  }

  if (parsed.resultCode !== 0) {
    await db.update(payments)
      .set({
        status: "failed",
        resultCode: parsed.resultCode,
        resultDesc: parsed.resultDesc,
      })
      .where(eq(payments.id, payment.id));

    return c.json(ACK, HttpStatusCodes.OK);
  }

  // The callback claims success. Check the amount against what we asked for
  // before believing it — a forged callback would otherwise confirm a booking
  // for any amount at all.
  if (parsed.amountCents != null && parsed.amountCents !== payment.amountCents) {
    log.error(
      {
        paymentId: payment.id,
        expected: payment.amountCents,
        received: parsed.amountCents,
      },
      "M-Pesa callback amount does not match the booking; refusing to confirm",
    );

    await db.update(payments)
      .set({
        status: "failed",
        resultCode: parsed.resultCode,
        resultDesc: "Amount mismatch between callback and booking",
      })
      .where(eq(payments.id, payment.id));

    return c.json(ACK, HttpStatusCodes.OK);
  }

  // Safaricom is the authority on whether money actually moved. Ask it
  // directly rather than taking an unauthenticated POST at its word.
  let verified;
  try {
    verified = await queryStkStatus(parsed.checkoutRequestId);
  }
  catch (err) {
    // Fail closed: leave the payment pending so reconciliation can settle it.
    // Confirming here on an unverifiable callback is the one outcome worth
    // avoiding entirely.
    log.error(
      { err, paymentId: payment.id },
      "Could not verify M-Pesa payment with Safaricom; left pending",
    );
    return c.json(ACK, HttpStatusCodes.OK);
  }

  if (verified.resultCode !== 0) {
    log.warn(
      { paymentId: payment.id, verified },
      "Callback claimed success but Safaricom disagrees; marking failed",
    );

    await db.update(payments)
      .set({
        status: "failed",
        resultCode: verified.resultCode,
        resultDesc: verified.resultDesc,
      })
      .where(eq(payments.id, payment.id));

    return c.json(ACK, HttpStatusCodes.OK);
  }

  await db.transaction(async (tx) => {
    await tx.update(payments)
      .set({
        status: "success",
        mpesaReceiptNumber: parsed.mpesaReceiptNumber,
        resultCode: parsed.resultCode,
        resultDesc: parsed.resultDesc,
      })
      .where(eq(payments.id, payment.id));

    // Guarded on the current status: if the guest cancelled while the payment
    // was in flight, the money is recorded but the booking is NOT resurrected.
    // That surfaces as a successful payment against a cancelled booking, which
    // is a refund case for a human, not something to paper over here.
    await tx.update(bookings)
      .set({ status: "confirmed" })
      .where(and(
        eq(bookings.id, payment.bookingId),
        eq(bookings.status, "pending_payment"),
      ));
  });

  log.info({ paymentId: payment.id }, "M-Pesa payment confirmed");

  return c.json(ACK, HttpStatusCodes.OK);
};

export const listForBooking: AppRouteHandler<ListForBookingRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const user = c.var.user!;

  const [booking] = await db.select({ guestId: bookings.guestId })
    .from(bookings)
    .where(eq(bookings.id, id));

  if (!booking || (user.role !== "admin" && booking.guestId !== user.id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const rows = await db.select().from(payments).where(eq(payments.bookingId, id)).orderBy(desc(payments.createdAt));

  return c.json({ data: rows }, HttpStatusCodes.OK);
};
