import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  conflictSchema,
  forbiddenSchema,
  notFoundSchema,
  tooManyRequestsSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireAuth, requireRole } from "@/middlewares/auth";

const tags = ["Admin"];

const adminOnly = () => [requireAuth, requireRole("admin")];

export const reconcileResponseSchema = z.object({
  examined: z.number().int(),
  paid: z.number().int(),
  failed: z.number().int(),
  alreadySettled: z.number().int(),
  unresolved: z.number().int(),
  releasedUndispatched: z.number().int(),
  staysCompleted: z.number().int(),
});

export const attentionResponseSchema = z.object({
  data: z.array(z.object({
    paymentId: z.string(),
    bookingId: z.string(),
    amountCents: z.number().int(),
    reason: z.enum([
      "dispatched_without_reference",
      "possible_duplicate_charge",
      "paid_but_cancelled",
      "stuck_pending",
    ]),
    detail: z.string().nullable(),
    createdAt: z.date(),
  })),
});

/**
 * What an admin may see about a payment attempt.
 *
 * Listed explicitly, and `checkoutRequestId` / `merchantRequestId` are
 * deliberately absent — the same rule the guest-facing payment history
 * follows. Those ids are all an unauthenticated M-Pesa callback needs to
 * identify an attempt, so handing one out anywhere lets a forged result be
 * aimed at a real payment. A bare select here would start leaking whichever
 * correlation id is added to the table next.
 *
 * `refundedCents` rides along so a list of payments does not need a refund
 * request per row to say what is still owed.
 */
export const adminPaymentSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  provider: z.string(),
  phoneNumber: z.string(),
  amountCents: z.number().int(),
  status: z.enum(["pending", "success", "failed", "timeout"]),
  mpesaReceiptNumber: z.string().nullable(),
  resultDesc: z.string().nullable(),
  refundedCents: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * `from` and `to` are Kenyan calendar days, half-open `[from, to)`.
 *
 * Either may stand alone — "everything since the 1st" is a real question,
 * unlike a stay with only one date. The boundaries are resolved in the
 * business zone: bounded in UTC, a month's takings would drop its first three
 * hours and gain the last three of the month before.
 */
export const listPaymentsQuerySchema = z.object({
  status: z.enum(["pending", "success", "failed", "timeout"]).optional(),
  bookingId: z.string().uuid().optional(),
  from: z.iso.date().optional().openapi({ example: "2026-09-01" }),
  to: z.iso.date().optional().openapi({ example: "2026-10-01" }),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
}).refine(
  q => q.from === undefined || q.to === undefined || q.to > q.from,
  { message: "to must be after from", path: ["to"] },
);

export const listPaymentsResponseSchema = z.object({
  data: z.array(adminPaymentSchema),
  /**
   * Computed over every matching payment, not the page — a total of one page
   * is not a total. `received` counts `success` attempts only: a pending or
   * failed attempt is not money, and counting it would overstate takings by
   * however many prompts went unanswered.
   */
  totals: z.object({
    receivedCents: z.number().int(),
    refundedCents: z.number().int(),
    netCents: z.number().int(),
  }),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

export const listPayments = createRoute({
  path: "/admin/payments",
  method: "get",
  tags,
  summary: "Every payment attempt, with what was actually received",
  description:
    "Admin only. Until this existed, payments could be read one booking at a "
    + "time, so there was no way to total money actually taken.\n\n"
    + "`totals` covers every matching attempt rather than the page. "
    + "`receivedCents` counts `success` attempts only — a pending or failed "
    + "attempt is not money — and `netCents` is what is left after refunds "
    + "recorded against those attempts.\n\n"
    + "`from`/`to` are Kenyan calendar days and half-open, so `from=2026-09-01"
    + "&to=2026-10-01` is exactly September. Correlation ids are never "
    + "returned, here or anywhere else.",
  middleware: adminOnly(),
  request: {
    query: listPaymentsQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(listPaymentsResponseSchema, "A page of attempts"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(listPaymentsQuerySchema),
      "The validation error(s)",
    ),
  },
});

export const reconcile = createRoute({
  path: "/admin/payments/reconcile",
  method: "post",
  tags,
  summary: "Settle payment attempts whose outcome was never confirmed",
  description:
    "Asks Safaricom about every attempt still pending, and settles those it "
    + "can. The payment flow deliberately leaves an attempt pending whenever "
    + "it cannot prove what happened, so this is what eventually resolves "
    + "them. Idempotent — safe to run on a schedule and safe to run twice at "
    + "once. NOT scheduled automatically: point an external cron at it.",
  middleware: adminOnly(),
  responses: {
    [HttpStatusCodes.OK]: jsonContent(reconcileResponseSchema, "What the sweep settled"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
  },
});

export const recordRefundSchema = z.object({
  amountCents: z.number().int().positive().refine(
    n => n % 100 === 0,
    "Amount must be a whole number of shillings (divisible by 100)",
  ),
  reason: z.string().trim().min(1).max(500).openapi({ example: "Guest cancelled after payment" }),
  /**
   * The transaction that carried the money back — required. Recording a
   * refund removes the payment from the attention list, so without proof the
   * money moved, an intention would silently clear a real debt.
   */
  mpesaReference: z.string().trim().min(1).max(64).openapi({ example: "SDJ4H2K1LM" }),
});

export const refundResponseSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  amountCents: z.number().int(),
  reason: z.string(),
  mpesaReference: z.string(),
  createdAt: z.date(),
});

export const listRefundsResponseSchema = z.object({
  data: z.array(refundResponseSchema),
  paymentCents: z.number().int(),
  refundedCents: z.number().int(),
  outstandingCents: z.number().int(),
});

export const recordRefund = createRoute({
  path: "/admin/payments/{id}/refunds",
  method: "post",
  tags,
  summary: "Record money returned to a guest",
  description:
    "Records a refund; it does NOT move money. Safaricom's Reversal API is a "
    + "separate product this system has no credentials for, so send the money "
    + "yourself and record its reference here — the reference is required, "
    + "because recording a refund clears the payment from the attention list "
    + "and an unbacked record would hide money that never moved. Partial "
    + "refunds are allowed, "
    + "and the total can never exceed what the guest paid. Once a payment is "
    + "fully refunded it stops appearing in the attention list.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(recordRefundSchema, "The refund"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.CREATED]: jsonContent(refundResponseSchema, "The recorded refund"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Payment not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "The payment did not succeed, or this would refund more than was paid",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(recordRefundSchema),
      "The validation error(s)",
    ),
  },
});

export const listRefunds = createRoute({
  path: "/admin/payments/{id}/refunds",
  method: "get",
  tags,
  summary: "Refunds recorded against a payment",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(listRefundsResponseSchema, "The refunds"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Payment not found"),
  },
});

export const attention = createRoute({
  path: "/admin/payments/attention",
  method: "get",
  tags,
  summary: "Payments a human needs to look at",
  description:
    "Everything reconciliation cannot fix by itself: prompts sent without a "
    + "recorded reference, possible duplicate charges, money received against "
    + "a cancelled booking, and attempts stuck pending. Each one is real money "
    + "that may need a refund or a manual confirmation.",
  middleware: adminOnly(),
  responses: {
    [HttpStatusCodes.OK]: jsonContent(attentionResponseSchema, "Items needing attention"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
  },
});

export type ReconcileRoute = typeof reconcile;
export type RecordRefundRoute = typeof recordRefund;
export type ListRefundsRoute = typeof listRefunds;
export type AttentionRoute = typeof attention;
export type ListPaymentsRoute = typeof listPayments;
