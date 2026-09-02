import { and, asc, count, desc, eq, gte, lt, sql, sum } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { payments, refunds } from "@/db/schema";
import { startOfBusinessDay } from "@/lib/dates";
import {
  completePastStays,
  paymentsNeedingAttention,
  reconcilePayments,
  releaseUndispatched,
} from "@/lib/reconciliation";
import { recordRefund as recordRefundForPayment } from "@/lib/refunds";

import type {
  AttentionRoute,
  ListPaymentsRoute,
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

  // Summed from the rows just read rather than re-queried. A second statement
  // gets a second snapshot, so a refund landing between the two would make the
  // total disagree with the list printed beside it. The list is unpaginated,
  // so this sum is the same number by construction.
  const refundedCents = data.reduce((total, r) => total + r.amountCents, 0);

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

/**
 * How much of one attempt has been given back.
 *
 * A correlated subquery rather than a join: a payment with two refunds must
 * appear once carrying their sum, and joining would repeat the payment row.
 *
 * Built with the query builder rather than written into the `sql` template.
 * Drizzle only qualifies column names it knows are ambiguous, and a template
 * referring to an outer table is not something it can see: written by hand,
 * the correlation renders as `where "payment_id" = "id"`, which resolves both
 * sides against `refunds` and quietly sums nothing at all. Passing the
 * builder in makes it `"refunds"."payment_id" = "payments"."id"`.
 */
const refundedForPayment = sql<number>`coalesce(${
  db.select({ total: sum(refunds.amountCents) })
    .from(refunds)
    .where(eq(refunds.paymentId, payments.id))
}, 0)`.mapWith(Number);

export const listPayments: AppRouteHandler<ListPaymentsRoute> = async (c) => {
  const { status, bookingId, from, to, page, limit } = c.req.valid("query");

  const filters = [];

  if (status)
    filters.push(eq(payments.status, status));
  if (bookingId)
    filters.push(eq(payments.bookingId, bookingId));

  // Kenyan calendar days, half-open. `startOfBusinessDay` resolves the
  // boundary in the business zone — read in UTC the window sits three hours
  // out of step with the day it claims to cover.
  if (from)
    filters.push(gte(payments.createdAt, startOfBusinessDay(from)));
  if (to)
    filters.push(lt(payments.createdAt, startOfBusinessDay(to)));

  const where = filters.length > 0 ? and(...filters) : undefined;

  /*
   * All three reads share one snapshot.
   *
   * Under READ COMMITTED each statement takes its own, and these are three
   * separate questions about the same set: the page, the count and what was
   * received, and the refunds against it. A refund committing between the
   * first and the third makes a row report itself unrefunded while `totals`
   * counts that refund; an attempt settling between the first and the second
   * changes `receivedCents` without changing the page it is supposed to
   * summarise. These figures exist to be reconciled against each other, so
   * they have to come from one moment. Same reasoning as the cancellation
   * email reading every attempt in one statement.
   *
   * REPEATABLE READ takes the snapshot once, at the first query. Read-only
   * because nothing here writes, and it tells Postgres so.
   *
   * The reads run in sequence rather than concurrently, which is not a cost
   * being paid for the snapshot: a transaction is a single connection, so
   * `Promise.all` would have interleaved them on one wire rather than running
   * them in parallel.
   */
  const { rows, summary, refunded } = await db.transaction(async (tx) => {
    // Columns are named, never selected wholesale: `checkoutRequestId` and
    // `merchantRequestId` are what an unauthenticated callback uses to
    // identify an attempt, so they must not leave the server.
    const attempts = await tx.select({
      id: payments.id,
      bookingId: payments.bookingId,
      provider: payments.provider,
      phoneNumber: payments.phoneNumber,
      amountCents: payments.amountCents,
      status: payments.status,
      mpesaReceiptNumber: payments.mpesaReceiptNumber,
      resultDesc: payments.resultDesc,
      refundedCents: refundedForPayment,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
    })
      .from(payments)
      .where(where)
      .limit(limit)
      .offset((page - 1) * limit)
      // `createdAt` is not unique, so offset pagination needs `id` to make the
      // order total.
      .orderBy(desc(payments.createdAt), asc(payments.id));

    // Over every match, not the page. `filter (where status = 'success')`
    // because a pending or failed attempt is not money — counting one would
    // report takings for a prompt nobody answered.
    const [totals] = await tx.select({
      total: count(),
      receivedCents: sql<number>`coalesce(sum(${payments.amountCents})
        filter (where ${payments.status} = 'success'), 0)`.mapWith(Number),
    })
      .from(payments)
      .where(where);

    // Refunds against the same set. Separate from the query above because
    // joining refunds to payments there would repeat a payment that has two
    // of them and double-count its amount in `receivedCents`.
    const [{ refunded: refundedTotal }] = await tx.select({
      refunded: sql<number>`coalesce(sum(${refunds.amountCents}), 0)`.mapWith(Number),
    })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(where);

    return { rows: attempts, summary: totals, refunded: refundedTotal };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  return c.json({
    data: rows,
    totals: {
      receivedCents: summary.receivedCents,
      refundedCents: refunded,
      netCents: summary.receivedCents - refunded,
    },
    meta: {
      page,
      limit,
      total: summary.total,
      totalPages: Math.ceil(summary.total / limit),
    },
  }, HttpStatusCodes.OK);
};
