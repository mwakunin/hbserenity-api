import { eq, sql, sum } from "drizzle-orm";

import db from "@/db";
import { payments, refunds } from "@/db/schema";

/**
 * Recording money returned to a guest.
 *
 * The money itself moves by hand — Safaricom's Reversal API is a separate
 * product needing credentials this system does not hold. What matters here is
 * that the system stops believing it still owes something once it doesn't,
 * and never records more going back than came in.
 */

export type RefundOutcome
  = | { kind: "recorded"; refund: typeof refunds.$inferSelect }
  /** No such payment. */
    | { kind: "not_found" }
  /** You cannot return money that was never taken. */
    | { kind: "not_successful"; status: string }
  /** Would take total refunds past what the guest actually paid. */
    | { kind: "exceeds_payment"; alreadyRefundedCents: number; paymentCents: number };

/** Total already returned for a payment. */
export async function refundedTotal(paymentId: string): Promise<number> {
  const [row] = await db.select({ total: sum(refunds.amountCents) })
    .from(refunds)
    .where(eq(refunds.paymentId, paymentId));

  // sum() is null when there are no rows, and a string otherwise.
  return row?.total == null ? 0 : Number(row.total);
}

export async function recordRefund(input: {
  paymentId: string;
  amountCents: number;
  reason: string;
  mpesaReference?: string;
  issuedBy: string;
}): Promise<RefundOutcome> {
  return db.transaction(async (tx) => {
    // FOR UPDATE on the payment. "Total refunds must not exceed the payment"
    // spans rows, so no CHECK constraint can express it — two concurrent
    // refunds would each see the old total and both pass. Locking the payment
    // serializes them, which is what makes the sum trustworthy.
    const [payment] = await tx.select()
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .for("update");

    if (!payment)
      return { kind: "not_found" as const };

    if (payment.status !== "success")
      return { kind: "not_successful" as const, status: payment.status };

    const [totals] = await tx.select({ total: sum(refunds.amountCents) })
      .from(refunds)
      .where(eq(refunds.paymentId, input.paymentId));

    const alreadyRefundedCents = totals?.total == null ? 0 : Number(totals.total);

    if (alreadyRefundedCents + input.amountCents > payment.amountCents) {
      return {
        kind: "exceeds_payment" as const,
        alreadyRefundedCents,
        paymentCents: payment.amountCents,
      };
    }

    const [refund] = await tx.insert(refunds).values({
      paymentId: input.paymentId,
      amountCents: input.amountCents,
      reason: input.reason,
      mpesaReference: input.mpesaReference,
      issuedBy: input.issuedBy,
    }).returning();

    return { kind: "recorded" as const, refund };
  });
}

/**
 * SQL fragment: payments whose refunds cover the full amount.
 *
 * Used to stop the attention list flagging money that has already been sent
 * back — otherwise every handled case would sit there forever and the list
 * would stop being worth reading.
 */
export const fullyRefunded = sql`
  COALESCE((
    SELECT sum(r."amount_cents") FROM "refunds" r
    WHERE r."payment_id" = ${payments.id}
  ), 0) >= ${payments.amountCents}
`;
