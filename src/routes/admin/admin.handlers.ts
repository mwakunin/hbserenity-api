import { desc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { payments, refunds } from "@/db/schema";
import {
  completePastStays,
  paymentsNeedingAttention,
  reconcilePayments,
  releaseUndispatched,
} from "@/lib/reconciliation";
import { recordRefund as recordRefundForPayment, refundedTotal } from "@/lib/refunds";

import type {
  AttentionRoute,
  ListRefundsRoute,
  ReconcileRoute,
  RecordRefundRoute,
} from "./admin.routes";

export const reconcile: AppRouteHandler<ReconcileRoute> = async (c) => {
  const summary = await reconcilePayments(c.var.logger);

  // Attempts that never reached a push hold nothing real, so freeing them is
  // safe and unblocks the guest's retries.
  const releasedUndispatched = await releaseUndispatched();

  // Stays that have ended move to `completed`, which is what makes them
  // reviewable. Nothing else advances a booking past `confirmed`.
  const staysCompleted = await completePastStays();

  return c.json(
    { ...summary, releasedUndispatched, staysCompleted },
    HttpStatusCodes.OK,
  );
};

export const recordRefund: AppRouteHandler<RecordRefundRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { amountCents, reason, mpesaReference } = c.req.valid("json");

  const outcome = await recordRefundForPayment({
    paymentId: id,
    amountCents,
    reason,
    mpesaReference,
    issuedBy: c.var.user!.id,
  });

  switch (outcome.kind) {
    case "not_found":
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );

    case "not_successful":
      return c.json(
        { message: `This payment is '${outcome.status}', so no money was taken to return.` },
        HttpStatusCodes.CONFLICT,
      );

    case "exceeds_payment":
      return c.json(
        {
          message: `Refunding that would exceed the payment: ${outcome.alreadyRefundedCents} of ${outcome.paymentCents} cents has already been returned.`,
        },
        HttpStatusCodes.CONFLICT,
      );

    case "recorded":
      return c.json(outcome.refund, HttpStatusCodes.CREATED);
  }
};

export const listRefunds: AppRouteHandler<ListRefundsRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [payment] = await db.select({ amountCents: payments.amountCents })
    .from(payments)
    .where(eq(payments.id, id));

  if (!payment) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const data = await db.select({
    id: refunds.id,
    paymentId: refunds.paymentId,
    amountCents: refunds.amountCents,
    reason: refunds.reason,
    mpesaReference: refunds.mpesaReference,
    createdAt: refunds.createdAt,
  })
    .from(refunds)
    .where(eq(refunds.paymentId, id))
    .orderBy(desc(refunds.createdAt));

  const refundedCents = await refundedTotal(id);

  return c.json({
    data,
    paymentCents: payment.amountCents,
    refundedCents,
    // What a human still owes the guest, so the number is directly actionable.
    outstandingCents: payment.amountCents - refundedCents,
  }, HttpStatusCodes.OK);
};

export const attention: AppRouteHandler<AttentionRoute> = async (c) => {
  const data = await paymentsNeedingAttention();
  return c.json({ data }, HttpStatusCodes.OK);
};
