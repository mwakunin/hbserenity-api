import { and, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";

import db from "@/db";
import { bookings, payments } from "@/db/schema";

import { RESOLVABLE_STATUSES, settleAttemptFromProvider } from "./payment-settlement";
import { fullyRefunded } from "./refunds";

/**
 * The payment flow deliberately fails closed: whenever it cannot prove what
 * happened, it leaves an attempt pending rather than guessing. That is only
 * safe because something eventually resolves those attempts — this.
 *
 * Without it, a guest whose callback never arrived has paid and holds a
 * booking that never confirms, and their retries stay blocked.
 */

/**
 * Attempts younger than this are left alone: their callback is probably still
 * in flight, and racing it just wastes Safaricom calls.
 */
const MIN_AGE_MS = 3 * 60 * 1000;

/** Past this, an attempt nobody could settle is escalated rather than retried. */
const STUCK_AFTER_MS = 60 * 60 * 1000;

/** Marker written by the payment flow when a prompt outran its booking. */
const DUPLICATE_FLAG = "%possible duplicate charge%";

export interface ReconcileSummary {
  examined: number;
  paid: number;
  failed: number;
  /** Settled by a concurrent callback or runner before this pass got to it. */
  alreadySettled: number;
  unresolved: number;
}

interface Logger {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

/**
 * Sweeps unresolved attempts and asks Safaricom what happened to each.
 *
 * Idempotent and safe to run concurrently with itself or with a live callback:
 * every write is a compare-and-swap, so a second runner settles nothing twice.
 */
export async function reconcilePayments(log: Logger): Promise<ReconcileSummary> {
  const olderThan = new Date(Date.now() - MIN_AGE_MS);

  const stale = await db.select().from(payments).where(and(
    // The same set the settlement module treats as still resolvable.
    // `timeout` records that we stopped waiting, not that Safaricom ruled, so
    // an aged timeout row with a reference must still be swept — a late
    // callback could settle it, and so should this.
    inArray(payments.status, RESOLVABLE_STATUSES),
    isNotNull(payments.checkoutRequestId),
    lt(payments.createdAt, olderThan),
  ));

  const summary: ReconcileSummary = {
    examined: stale.length,
    paid: 0,
    failed: 0,
    alreadySettled: 0,
    unresolved: 0,
  };

  // Sequential on purpose: Daraja rate-limits, and a sweep has no deadline.
  for (const attempt of stale) {
    const outcome = await settleAttemptFromProvider(attempt, log);

    // Counted by what this pass actually changed, so the admin summary can't
    // claim a settlement that a concurrent runner or callback really made.
    if (outcome === "paid")
      summary.paid += 1;
    else if (outcome === "dead")
      summary.failed += 1;
    else if (outcome === "already_settled")
      summary.alreadySettled += 1;
    else
      summary.unresolved += 1;
  }

  if (summary.paid > 0 || summary.failed > 0)
    log.info({ summary }, "Payment reconciliation settled attempts");

  return summary;
}

export interface AttentionItem {
  paymentId: string;
  bookingId: string;
  amountCents: number;
  reason:
  /** A push went out but its id was never stored — nothing to query. */
    | "dispatched_without_reference"
    /** A prompt was sent after its booking was already settled. */
    | "possible_duplicate_charge"
    /** Money arrived against a booking the guest had cancelled. */
    | "paid_but_cancelled"
    /** Pending far longer than any callback should take. */
    | "stuck_pending";
  detail: string | null;
  createdAt: Date;
}

/**
 * Everything reconciliation cannot fix by itself, for a human to work through.
 *
 * These are exactly the states the payment flow chooses on purpose when it
 * cannot prove what happened — each represents real money that may need a
 * refund or a manual confirmation.
 */
export async function paymentsNeedingAttention(): Promise<AttentionItem[]> {
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);

  const rows = await db.select({
    paymentId: payments.id,
    bookingId: payments.bookingId,
    amountCents: payments.amountCents,
    status: payments.status,
    resultDesc: payments.resultDesc,
    checkoutRequestId: payments.checkoutRequestId,
    pushDispatchedAt: payments.pushDispatchedAt,
    createdAt: payments.createdAt,
    bookingStatus: bookings.status,
  })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(sql`
      (${payments.status} = 'pending'
        AND ${payments.pushDispatchedAt} IS NOT NULL
        AND ${payments.checkoutRequestId} IS NULL)
      OR (${payments.resultDesc} ILIKE ${DUPLICATE_FLAG} AND NOT (${fullyRefunded}))
      OR (${payments.status} = 'success' AND ${bookings.status} = 'cancelled'
        AND NOT (${fullyRefunded}))
      OR (${payments.status} IN ('pending', 'timeout')
        AND ${payments.createdAt} < ${stuckBefore})
    `)
    .orderBy(payments.createdAt);

  return rows.map((r) => {
    const reason: AttentionItem["reason"]
      = r.status === "success" && r.bookingStatus === "cancelled"
        ? "paid_but_cancelled"
        : r.resultDesc?.toLowerCase().includes("possible duplicate charge")
          ? "possible_duplicate_charge"
          : r.pushDispatchedAt && !r.checkoutRequestId
            ? "dispatched_without_reference"
            : "stuck_pending";

    return {
      paymentId: r.paymentId,
      bookingId: r.bookingId,
      amountCents: r.amountCents,
      reason,
      detail: r.resultDesc,
      createdAt: r.createdAt,
    };
  });
}

/**
 * Moves finished stays from `confirmed` to `completed`.
 *
 * Nothing else advanced a booking past `confirmed`, so the lifecycle
 * documented as pending_payment -> confirmed -> completed stopped one step
 * short and the final status was unreachable. Reviews depend on it: only a
 * guest who actually stayed may review, and this is what records that.
 *
 * Uses the half-open convention — a stay ending today is over, because
 * check-out day is already bookable by the next guest.
 */
export async function completePastStays(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  const completed = await db.update(bookings)
    .set({ status: "completed" })
    .where(and(
      eq(bookings.status, "confirmed"),
      lte(bookings.checkOut, today),
    ))
    .returning({ id: bookings.id });

  return completed.length;
}

/** Releases attempts that never got as far as a push, so retries aren't blocked. */
export async function releaseUndispatched(): Promise<number> {
  const olderThan = new Date(Date.now() - MIN_AGE_MS);

  const released = await db.update(payments)
    .set({ status: "timeout", resultDesc: "Push was never dispatched" })
    .where(and(
      eq(payments.status, "pending"),
      isNull(payments.pushDispatchedAt),
      isNull(payments.checkoutRequestId),
      lt(payments.createdAt, olderThan),
    ))
    .returning({ id: payments.id });

  return released.length;
}
