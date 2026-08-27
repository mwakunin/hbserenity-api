import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { payments } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectPaymentSchema = toZodV4SchemaTyped(createSelectSchema(payments));

export const initiatePaymentSchema = z.object({
  /**
   * Optional — defaults to the phone number on the guest's account. Allows
   * paying from a different M-Pesa line than the one used to sign in, which
   * is common when someone else settles the bill.
   */
  phoneNumber: z.string().min(1).optional().openapi({ example: "+254712345678" }),
});

/**
 * Deliberately omits `checkoutRequestId`.
 *
 * That id is what the callback uses to identify a payment. Handing it to the
 * client would let a guest start a real STK push, cancel it, then POST a
 * forged success callback for their own booking.
 */
export const initiatePaymentResponseSchema = z.object({
  paymentId: z.string(),
  status: z.enum(["pending", "success", "failed", "timeout"]),
  /** Safaricom's own wording, suitable for showing to the guest. */
  customerMessage: z.string(),
});

/**
 * Safaricom's callback envelope. Modelled loosely on purpose: the payload is
 * unauthenticated and attacker-controllable, so rejecting it at the schema
 * layer buys nothing. Everything is verified against our records instead, and
 * a malformed body must still return 200 or Safaricom retries it forever.
 */
export const mpesaCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().optional(),
      CheckoutRequestID: z.string().optional(),
      ResultCode: z.union([z.number(), z.string()]).optional(),
      ResultDesc: z.string().optional(),
      CallbackMetadata: z.object({
        Item: z.array(z.object({
          Name: z.string().optional(),
          Value: z.union([z.string(), z.number()]).optional(),
        })).optional(),
      }).optional(),
    }).optional(),
  }).optional(),
}).passthrough();

/** What Safaricom expects back. Anything else and it keeps retrying. */
export const mpesaAckSchema = z.object({
  ResultCode: z.number(),
  ResultDesc: z.string(),
});

/**
 * What a payment attempt looks like to its owner.
 *
 * `checkoutRequestId` and `merchantRequestId` are deliberately absent. They
 * are how the callback identifies a payment, so anyone holding one can forge a
 * result for it — returning them here would undo the same omission that
 * `initiatePaymentResponseSchema` is careful about.
 */
export const publicPaymentSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  provider: z.string(),
  phoneNumber: z.string(),
  amountCents: z.number().int(),
  status: z.enum(["pending", "success", "failed", "timeout"]),
  mpesaReceiptNumber: z.string().nullable(),
  resultDesc: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const listPaymentsResponseSchema = z.object({
  data: z.array(publicPaymentSchema),
});
