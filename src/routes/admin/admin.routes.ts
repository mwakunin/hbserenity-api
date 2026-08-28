import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { forbiddenSchema, unauthorizedSchema } from "@/lib/constants";
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
export type AttentionRoute = typeof attention;
