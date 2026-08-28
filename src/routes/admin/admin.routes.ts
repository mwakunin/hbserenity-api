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
  /** The M-Pesa transaction that carried the money back, once sent. */
  mpesaReference: z.string().trim().min(1).max(64).optional(),
});

export const refundResponseSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  amountCents: z.number().int(),
  reason: z.string(),
  mpesaReference: z.string().nullable(),
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
    + "yourself and record the reference here. Partial refunds are allowed, "
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
