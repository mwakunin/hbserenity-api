import { and, eq, inArray } from "drizzle-orm";

import db from "@/db";
import { bookings, payments } from "@/db/schema";

import { queryStkStatus, verdictFor } from "./mpesa";
import { notifyBookingConfirmed, notifyPaymentReceipt } from "./notifications";

/**
 * Settling a payment attempt happens from three places — the retry path, the
 * callback, and reconciliation — and they must agree exactly. Earlier versions
 * of this code answered "may this attempt stop holding its booking?"
 * separately in each, and drifted: 1001 ("transaction in process") ended up
 * terminal in one and still-live in another.
 *
 * Everything that settles an attempt goes through here.
 */

/** Outcomes Safaricom has ruled on. A late callback must not reopen these. */
export const SETTLED_STATUSES = new Set(["success", "failed"]);

/**
 * Statuses a settlement may still write to.
 *
 * `timeout` is included on purpose: it records that *we* stopped waiting, not
 * that Safaricom ruled, so a later confirmation must still be able to land.
 */
export const RESOLVABLE_STATUSES = ["pending", "timeout"] as const;

export type SettleOutcome
  /** This call confirmed payment; the attempt and its booking are settled. */
  = | "paid"
  /** This call recorded a terminal failure; the attempt no longer holds. */
    | "dead"
  /**
   * Something else settled it first and this call changed nothing.
   *
   * Distinct from `paid`/`dead` on purpose: the winner's outcome is unknown
   * here, so reporting either would state something that may contradict what
   * is actually stored. The attempt is settled either way, so it no longer
   * holds its booking.
   */
    | "already_settled"
  /** No verdict available — the attempt keeps holding its booking. */
    | "unresolved";

interface Logger {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

/** Anything that can run a statement — the pool, or a transaction on it. */
type Executor = Pick<typeof db, "update">;

/**
 * Move a booking to `confirmed` because its payment succeeded.
 *
 * Guarded on `pending_payment`, so a booking cancelled while the payment was
 * in flight is NOT resurrected. That surfaces as money against a cancelled
 * booking, which is a refund for a human rather than something to paper over.
 *
 * Returns whether **this** call is the one that moved the row. Both the
 * callback and this module confirm bookings, and each is idempotent, so
 * without that distinction there is no way to tell a real confirmation from a
 * reconciliation pass over an already-confirmed booking — and the guest would
 * be mailed again every sweep.
 */
export async function confirmPaidBooking(
  tx: Executor,
  bookingId: string,
): Promise<boolean> {
  const moved = await tx.update(bookings)
    .set({ status: "confirmed" })
    .where(and(
      eq(bookings.id, bookingId),
      eq(bookings.status, "pending_payment"),
    ))
    .returning({ id: bookings.id });

  return moved.length > 0;
}

/**
 * Asks Safaricom about one attempt and applies the answer.
 *
 * Idempotent and safe to run concurrently: every write is a compare-and-swap
 * against a resolvable status, so a racing callback and a reconciliation pass
 * cannot both settle the same attempt, and the loser changes nothing.
 */
export async function settleAttemptFromProvider(
  attempt: typeof payments.$inferSelect,
  log: Logger,
): Promise<SettleOutcome> {
  if (!attempt.checkoutRequestId) {
    // Nothing to ask about. A dispatched push with no id may have produced a
    // live prompt, so it must keep holding; that case needs a human.
    return "unresolved";
  }

  let status;
  try {
    status = await queryStkStatus(attempt.checkoutRequestId);
  }
  catch (err) {
    log.error({ err, paymentId: attempt.id }, "Could not reach Safaricom to settle attempt");
    return "unresolved";
  }

  const verdict = verdictFor(status.resultCode);

  if (verdict === "indeterminate") {
    log.warn(
      { paymentId: attempt.id, status },
      "Safaricom has no terminal result yet; attempt left holding",
    );
    return "unresolved";
  }

  if (verdict === "dead") {
    const won = await db.update(payments)
      .set({
        status: "failed",
        resultCode: status.resultCode,
        resultDesc: status.resultDesc,
      })
      .where(and(
        eq(payments.id, attempt.id),
        inArray(payments.status, RESOLVABLE_STATUSES),
      ))
      .returning({ id: payments.id });

    // Report what this call actually did, not what it intended.
    return won.length > 0 ? "dead" : "already_settled";
  }

  const settled = await db.transaction(async (tx) => {
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

    // Someone else settled it first; leave their outcome alone, and don't
    // claim this call paid anything.
    if (won.length === 0)
      return { outcome: "already_settled" as const, bookingConfirmed: false };

    const bookingConfirmed = await confirmPaidBooking(tx, attempt.bookingId);

    return { outcome: "paid" as const, bookingConfirmed };
  });

  // Mail only after the transaction has committed — inside it, a rollback
  // would leave the guest holding a confirmation for a booking that does not
  // exist. Neither call throws, so nothing here can undo the settlement.
  if (settled.outcome === "paid") {
    await notifyPaymentReceipt(attempt.id, log);

    if (settled.bookingConfirmed)
      await notifyBookingConfirmed(attempt.bookingId, log);
  }

  return settled.outcome;
}
