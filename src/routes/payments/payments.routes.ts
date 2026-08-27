import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import { conflictSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { requireAuth } from "@/middlewares/auth";

import {
  initiatePaymentResponseSchema,
  initiatePaymentSchema,
  listPaymentsResponseSchema,
  mpesaAckSchema,
  mpesaCallbackSchema,
} from "./payments.schemas";

const tags = ["Payments"];

export const initiate = createRoute({
  path: "/bookings/{id}/pay",
  method: "post",
  tags,
  summary: "Trigger an M-Pesa STK push for a booking",
  description:
    "Prompts the guest's handset for a PIN. Returns as soon as Safaricom "
    + "accepts the request — the booking is NOT confirmed here. Confirmation "
    + "happens when the callback arrives and is verified against Safaricom.",
  middleware: [requireAuth],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(initiatePaymentSchema, "Optional paying number"),
  },
  responses: {
    [HttpStatusCodes.ACCEPTED]: jsonContent(
      initiatePaymentResponseSchema,
      "The push was accepted by Safaricom",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Booking not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "Already paid, not payable, or a push is already in flight",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(initiatePaymentSchema),
      "Invalid phone number",
    ),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
      notFoundSchema,
      "Safaricom rejected the request or was unreachable",
    ),
  },
});

export const callback = createRoute({
  path: "/mpesa/callback",
  method: "post",
  tags,
  summary: "Safaricom STK push result callback",
  description:
    "Public and unauthenticated — Safaricom does not sign callbacks. The "
    + "payload is treated as a hint, never as proof: the outcome is confirmed "
    + "by querying Safaricom directly before any booking changes state. "
    + "Always answers 200, because any other status makes Safaricom retry.",
  request: {
    body: jsonContentRequired(mpesaCallbackSchema, "Safaricom's callback envelope"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(mpesaAckSchema, "Acknowledged"),
  },
});

export const listForBooking = createRoute({
  path: "/bookings/{id}/payments",
  method: "get",
  tags,
  summary: "Payment attempts for a booking",
  description:
    "Every STK push attempt, newest first. Retries are separate rows, so this "
    + "is the full audit trail rather than just the current state.",
  middleware: [requireAuth],
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(listPaymentsResponseSchema, "The attempts"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Booking not found"),
  },
});

export type InitiateRoute = typeof initiate;
export type CallbackRoute = typeof callback;
export type ListForBookingRoute = typeof listForBooking;
