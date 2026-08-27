import { and, desc, eq, inArray } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { bookings, payments } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
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
 * How long a pending push blocks another attempt outright. Safaricom's prompt
 * expires after roughly a minute; re-pushing before that would put a second
 * PIN prompt on the guest's handset for the same booking.
 *
 * Past this window we don't simply assume the prompt died — we ask. See
 * releaseStaleAttempt.
 */
const PUSH_COOLDOWN_MS = 90_000;

/** Outcomes Safaricom has ruled on. A late callback must not reopen these. */
const SETTLED_STATUSES = new Set(["success", "failed"]);

/** Statuses a callback may still settle — `timeout` is our guess, not a verdict. */
const RESOLVABLE_STATUSES = ["pending", "timeout"] as const;

/**
 * STK query result codes that mean the prompt is definitively finished, so a
 * fresh push cannot collide with it.
 *
 * Deliberately an allowlist. Anything else — including 1001 ("transaction in
 * process") and any query error — is treated as possibly still live, because
 * releasing a prompt that is actually open lets the guest be charged twice.
 */
const DEAD_RESULT_CODES = new Set([
  1, // insufficient balance
  1032, // cancelled by user
  1037, // timed out, user unreachable
  2001, // wrong PIN
]);

type StaleOutcome = "still_live" | "released" | "already_paid";

/**
 * Decides whether an existing pending attempt is finished, so a fresh push
 * can't collide with a prompt that is still open on the guest's handset.
 *
 * Simply timing out the row after a fixed window is not safe: the STK request
 * has no guaranteed lifetime, so releasing on a guess can leave two live
 * prompts and let the guest be charged twice for one booking. Safaricom is
 * asked instead, and the attempt is only released on a result code that
 * definitively means finished.
 */
async function releaseStaleAttempt(
  attempt: typeof payments.$inferSelect,
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
): Promise<StaleOutcome> {
  const age = Date.now() - attempt.createdAt.getTime();

  // Inside the cooldown the prompt is almost certainly still on screen.
  if (age < PUSH_COOLDOWN_MS)
    return "still_live";

  // No checkout id means the push never reached Safaricom, so no prompt was
  // ever delivered and there is nothing to collide with.
  //
  // This holds only because Daraja calls are bounded by DARAJA_TIMEOUT_MS,
  // which is well under PUSH_COOLDOWN_MS: an in-flight push has aborted long
  // before its attempt becomes eligible for release. Without that bound a push
  // could still be running here, later succeed, and add a second prompt.
  if (!attempt.checkoutRequestId) {
    await db.update(payments)
      .set({ status: "timeout", resultDesc: "Push never reached Safaricom" })
      .where(and(eq(payments.id, attempt.id), eq(payments.status, "pending")));
    return "released";
  }

  let status;
  try {
    status = await queryStkStatus(attempt.checkoutRequestId);
  }
  catch (err) {
    // Fail closed: unable to prove the old prompt is dead, so don't add another.
    log.error({ err, paymentId: attempt.id }, "Could not check a stale STK attempt");
    return "still_live";
  }

  if (status.resultCode === 0) {
    // It succeeded while we weren't looking. Settle it rather than charging again.
    await db.transaction(async (tx) => {
      const won = await tx.update(payments)
        .set({
          status: "success",
          resultCode: status.resultCode,
          resultDesc: status.resultDesc,
        })
        .where(and(
          eq(payments.id, attempt.id),
          inArray(payments.status, RESOLVABLE_STATUSES),
        ))
        .returning({ id: payments.id });

      if (won.length === 0)
        return;

      await tx.update(bookings)
        .set({ status: "confirmed" })
        .where(and(
          eq(bookings.id, attempt.bookingId),
          eq(bookings.status, "pending_payment"),
        ));
    });

    return "already_paid";
  }

  if (!DEAD_RESULT_CODES.has(status.resultCode)) {
    log.warn(
      { paymentId: attempt.id, status },
      "Stale STK attempt has no terminal result yet; not releasing it",
    );
    return "still_live";
  }

  await db.update(payments)
    .set({
      status: "failed",
      resultCode: status.resultCode,
      resultDesc: status.resultDesc,
    })
    .where(and(eq(payments.id, attempt.id), eq(payments.status, "pending")));

  return "released";
}

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

  const [inFlight] = await db.select().from(payments).where(and(
    eq(payments.bookingId, booking.id),
    eq(payments.status, "pending"),
  ));

  if (inFlight) {
    const outcome = await releaseStaleAttempt(inFlight, c.var.logger);

    if (outcome === "still_live") {
      return c.json(
        { message: "A payment prompt was already sent. Check your phone, or wait a moment before retrying." },
        HttpStatusCodes.CONFLICT,
      );
    }

    if (outcome === "already_paid") {
      return c.json(
        { message: "This booking has already been paid for." },
        HttpStatusCodes.CONFLICT,
      );
    }
  }

  // The pre-check above cannot hold on its own: two overlapping requests both
  // see "none pending" and both push, so the guest gets two PIN prompts and can
  // be charged twice. The `payments_one_pending_per_booking` partial unique
  // index is the real guard — the check just yields a clearer 409 in the
  // ordinary case.
  let payment;
  try {
    // A new row per attempt — payment history is append-only, so a retry never
    // overwrites the record of a previous failure.
    [payment] = await db.insert(payments).values({
      bookingId: booking.id,
      phoneNumber: payFrom,
      amountCents: booking.totalAmountCents,
    }).returning();
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "A payment prompt was already sent. Check your phone, or wait a moment before retrying." },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }

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
  //
  // `timeout` is deliberately NOT settled. It means we stopped waiting, which
  // is our guess rather than Safaricom's verdict; a late callback saying the
  // guest paid must still be honoured, or the money is taken and the booking
  // never confirms.
  if (SETTLED_STATUSES.has(payment.status)) {
    log.info(
      { paymentId: payment.id, status: payment.status },
      "M-Pesa callback for an already-settled payment; ignored",
    );
    return c.json(ACK, HttpStatusCodes.OK);
  }

  // Safaricom is the authority on whether money moved — for BOTH outcomes.
  //
  // Verifying only the success path would leave a hole: anyone able to forge a
  // *failure* could settle the attempt without proof, and the genuine success
  // callback would then be ignored as already-settled, stranding a booking the
  // guest has actually paid for.
  let verified;
  try {
    verified = await queryStkStatus(parsed.checkoutRequestId);
  }
  catch (err) {
    // Fail closed: leave the payment pending so reconciliation can settle it.
    // Acting on an unverifiable callback is the one outcome worth avoiding.
    log.error(
      { err, paymentId: payment.id },
      "Could not verify M-Pesa payment with Safaricom; left pending",
    );
    return c.json(ACK, HttpStatusCodes.OK);
  }

  /**
   * Settles the attempt only while it is still pending.
   *
   * The status filter makes this a compare-and-swap: two callbacks for one
   * checkout request can both read the row as pending, and without it the
   * loser would overwrite the winner — a failure clobbering a verified
   * success while its booking stayed confirmed.
   */
  const settle = (values: Partial<typeof payments.$inferInsert>) =>
    db.update(payments)
      .set(values)
      .where(and(
        eq(payments.id, payment.id),
        inArray(payments.status, RESOLVABLE_STATUSES),
      ))
      .returning({ id: payments.id });

  if (verified.resultCode !== 0) {
    await settle({
      status: "failed",
      resultCode: verified.resultCode,
      resultDesc: verified.resultDesc,
    });

    return c.json(ACK, HttpStatusCodes.OK);
  }

  // Safaricom says the money moved. Cross-check the amount the callback
  // reported against what we asked for before confirming anything.
  if (parsed.amountCents != null && parsed.amountCents !== payment.amountCents) {
    log.error(
      {
        paymentId: payment.id,
        expected: payment.amountCents,
        received: parsed.amountCents,
      },
      "M-Pesa callback amount does not match the booking; refusing to confirm",
    );

    await settle({
      status: "failed",
      resultCode: verified.resultCode,
      resultDesc: "Amount mismatch between callback and booking",
    });

    return c.json(ACK, HttpStatusCodes.OK);
  }

  await db.transaction(async (tx) => {
    const won = await tx.update(payments)
      .set({
        status: "success",
        mpesaReceiptNumber: parsed.mpesaReceiptNumber,
        resultCode: verified.resultCode,
        resultDesc: verified.resultDesc,
      })
      .where(and(
        eq(payments.id, payment.id),
        inArray(payments.status, RESOLVABLE_STATUSES),
      ))
      .returning({ id: payments.id });

    // Another callback settled it first; leave its outcome alone.
    if (won.length === 0)
      return;

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

  // Explicit column list, not select() — checkoutRequestId and
  // merchantRequestId must never reach the client, and a bare select would
  // start leaking any correlation id added to the table later.
  const rows = await db.select({
    id: payments.id,
    bookingId: payments.bookingId,
    provider: payments.provider,
    phoneNumber: payments.phoneNumber,
    amountCents: payments.amountCents,
    status: payments.status,
    mpesaReceiptNumber: payments.mpesaReceiptNumber,
    resultDesc: payments.resultDesc,
    createdAt: payments.createdAt,
    updatedAt: payments.updatedAt,
  })
    .from(payments)
    .where(eq(payments.bookingId, id))
    .orderBy(desc(payments.createdAt));

  return c.json({ data: rows }, HttpStatusCodes.OK);
};
