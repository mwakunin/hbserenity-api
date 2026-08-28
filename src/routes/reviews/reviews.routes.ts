import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  conflictSchema,
  notFoundSchema,
  tooManyRequestsSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireAuth } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";

import {
  createReviewSchema,
  listReviewsQuerySchema,
  listReviewsResponseSchema,
  selectReviewSchema,
} from "./reviews.schemas";

const tags = ["Reviews"];

export const create = createRoute({
  path: "/bookings/{id}/review",
  method: "post",
  tags,
  summary: "Review a completed stay",
  description:
    "Only the guest on the booking may review it, and only once the stay has "
    + "finished — a booking reaches 'completed' after its check-out date. "
    + "Tying reviews to a booking rather than a property is what stops anyone "
    + "reviewing somewhere they never stayed.",
  middleware: [requireAuth, rateLimits.write()],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(createReviewSchema, "The review"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.CREATED]: jsonContent(selectReviewSchema, "The created review"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Booking not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "The stay is not finished, or it has already been reviewed",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createReviewSchema),
      "The validation error(s)",
    ),
  },
});

export const listForProperty = createRoute({
  path: "/properties/{id}/reviews",
  method: "get",
  tags,
  summary: "Reviews for a property",
  description:
    "Public, newest first, with the average rating across all of them — not "
    + "just the page returned.",
  middleware: [rateLimits.read()],
  request: {
    params: IdUUIDParamsSchema,
    query: listReviewsQuerySchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(listReviewsResponseSchema, "A page of reviews"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(listReviewsQuerySchema),
      "Invalid pagination",
    ),
  },
});

export type CreateRoute = typeof create;
export type ListForPropertyRoute = typeof listForProperty;
