import { and, eq, inArray } from "drizzle-orm";

import db from "@/db";
import { bookings, payments } from "@/db/schema";

import { queryStkStatus, verdictFor } from "./mpesa";

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
  /** Safaricom confirmed payment; the attempt and its booking are settled. */
  = | "paid"
  /** Safaricom gave a terminal failure; the attempt no longer holds anything. */
    | "dead"
  /** No verdict available — the attempt keeps holding its booking. */
    | "unresolved";

interface Logger {
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
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
    await db.update(payments)
      .set({
        status: "failed",
        resultCode: status.resultCode,
        resultDesc: status.resultDesc,
      })
      .where(and(
        eq(payments.id, attempt.id),
        inArray(payments.status, RESOLVABLE_STATUSES),
      ));

    return "dead";
  }

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

    // Someone else settled it first; leave their outcome alone.
    if (won.length === 0)
      return;

    // Guarded on status: a booking cancelled while payment was in flight is
    // NOT resurrected. That surfaces as money against a cancelled booking,
    // which is a refund for a human rather than something to paper over.
    await tx.update(bookings)
      .set({ status: "confirmed" })
      .where(and(
        eq(bookings.id, attempt.bookingId),
        eq(bookings.status, "pending_payment"),
      ));
  });

  return "paid";
}
