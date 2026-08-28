import { createRoute } from "@hono/zod-openapi";
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
import { rateLimits } from "@/middlewares/rate-limit";

import {
  createRateOverrideSchema,
  listRateOverridesResponseSchema,
  quoteQuerySchema,
  quoteResponseSchema,
  selectRateOverrideSchema,
} from "./rates.schemas";

const tags = ["Rates"];

const adminOnly = () => [requireAuth, requireRole("admin"), rateLimits.write()];

export const createOverride = createRoute({
  path: "/rate-overrides",
  method: "post",
  tags,
  summary: "Price a date range differently",
  description:
    "Admin only. Overrides both the base and weekend rates for the nights it "
    + "covers. Ranges are half-open, so a season ending the 1st does not "
    + "price the 1st, and two overrides may not overlap — a night with two "
    + "prices has no defined answer.",
  middleware: adminOnly(),
  request: {
    body: jsonContentRequired(createRateOverrideSchema, "The seasonal rate"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.CREATED]: jsonContent(selectRateOverrideSchema, "The created override"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "Overlaps an existing override for this property",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createRateOverrideSchema),
      "The validation error(s)",
    ),
  },
});

export const listForProperty = createRoute({
  path: "/properties/{id}/rate-overrides",
  method: "get",
  tags,
  summary: "Seasonal rates for a property",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(listRateOverridesResponseSchema, "The overrides"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
  },
});

export const removeOverride = createRoute({
  path: "/rate-overrides/{id}",
  method: "delete",
  tags,
  summary: "Remove a seasonal rate",
  description:
    "Existing bookings are unaffected — their total was snapshotted when the "
    + "booking was made and is never recalculated.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.NO_CONTENT]: { description: "Override removed" },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Override not found"),
  },
});

export const quote = createRoute({
  path: "/properties/{id}/quote",
  method: "get",
  tags,
  summary: "What a stay would cost",
  description:
    "Public. Breaks the price down per night and says why each rate applied, "
    + "so a seasonal premium is visible before booking rather than after "
    + "being charged. This is the same calculation the booking uses.",
  middleware: [rateLimits.read()],
  request: {
    params: IdUUIDParamsSchema,
    query: quoteQuerySchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(quoteResponseSchema, "The price breakdown"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(quoteQuerySchema),
      "Invalid dates",
    ),
  },
});

export type CreateOverrideRoute = typeof createOverride;
export type ListForPropertyRoute = typeof listForProperty;
export type RemoveOverrideRoute = typeof removeOverride;
export type QuoteRoute = typeof quote;
