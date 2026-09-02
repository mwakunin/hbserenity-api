import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import { conflictSchema, forbiddenSchema, notFoundSchema, tooManyRequestsSchema, unauthorizedSchema } from "@/lib/constants";
import { requireAuth, requireRole } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";

import {
  availabilityQuerySchema,
  availabilityResponseSchema,
  cancelBookingSchema,
  createBlackoutSchema,
  createBookingSchema,
  listBlackoutsQuerySchema,
  listBlackoutsResponseSchema,
  listBookingsQuerySchema,
  listBookingsResponseSchema,
  selectBlackoutSchema,
  selectBookingSchema,
} from "./bookings.schemas";

const tags = ["Bookings"];

export const availability = createRoute({
  path: "/properties/{id}/availability",
  method: "get",
  tags,
  summary: "Which dates are already taken",
  description:
    "Public. Merges bookings that hold dates (pending_payment, confirmed) "
    + "with host blackouts. Ranges are half-open: an end date is free.",
  request: {
    params: IdUUIDParamsSchema,
    query: availabilityQuerySchema,
  },
  middleware: [rateLimits.read()],
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(availabilityResponseSchema, "Unavailable ranges"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(availabilityQuerySchema),
      "Invalid date range",
    ),
  },
});

export const create = createRoute({
  path: "/bookings",
  method: "post",
  tags,
  summary: "Book a property",
  description:
    "The total is computed server-side from the property's current rate and "
    + "snapshotted onto the booking. Returns 409 if the dates are taken.",
  middleware: [requireAuth, rateLimits.write()],
  request: {
    body: jsonContentRequired(createBookingSchema, "The booking to create"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.CREATED]: jsonContent(selectBookingSchema, "The created booking"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(conflictSchema, "Those dates are taken"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createBookingSchema),
      "The validation error(s)",
    ),
  },
});

export const list = createRoute({
  path: "/bookings",
  method: "get",
  tags,
  summary: "List bookings",
  description: "A guest sees only their own bookings; an admin sees all of them.",
  middleware: [requireAuth, rateLimits.read()],
  request: {
    query: listBookingsQuerySchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(listBookingsResponseSchema, "A page of bookings"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(listBookingsQuerySchema),
      "Invalid filter(s)",
    ),
  },
});

export const getOne = createRoute({
  path: "/bookings/{id}",
  method: "get",
  tags,
  summary: "Get one booking",
  middleware: [requireAuth, rateLimits.read()],
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(selectBookingSchema, "The booking"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Booking not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(IdUUIDParamsSchema),
      "Invalid id",
    ),
  },
});

export const cancel = createRoute({
  path: "/bookings/{id}/cancel",
  method: "post",
  tags,
  summary: "Cancel a booking",
  description:
    "A booking may be cancelled while it still holds its dates — "
    + "pending_payment or confirmed — by the guest who made it or by an "
    + "admin. Cancelling frees the dates for another guest immediately. A "
    + "stay that has already begun cannot be cancelled.\n\n"
    + "Cancelling a paid booking requires a reason, and does NOT move money: "
    + "the payment then shows on GET /admin/payments/attention as money held "
    + "against a cancelled booking, and the refund is recorded by hand.",
  middleware: [requireAuth, rateLimits.write()],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContent(cancelBookingSchema, "Why, if it was paid for"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(selectBookingSchema, "The cancelled booking"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not your booking"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Booking not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "Already cancelled or completed, or the stay has begun",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(cancelBookingSchema),
      "Invalid id, or no reason given for a paid booking",
    ),
  },
});

export const createBlackout = createRoute({
  path: "/blackouts",
  method: "post",
  tags: ["Blackouts"],
  summary: "Block dates on a property",
  description:
    "Admin only. Takes dates off the market for maintenance or personal use "
    + "without creating a fake booking. Returns 409 if the range overlaps "
    + "either an existing blackout or a booking that already holds the dates "
    + "— a sold stay can never be silently marked host-blocked.",
  middleware: [requireAuth, requireRole("admin"), rateLimits.write()],
  request: {
    body: jsonContentRequired(createBlackoutSchema, "The blackout to create"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.CREATED]: jsonContent(
      selectBlackoutSchema,
      "The created blackout",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "Overlaps an existing blackout or a booking holding those dates",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createBlackoutSchema),
      "The validation error(s)",
    ),
  },
});

export const listBlackouts = createRoute({
  path: "/blackouts",
  method: "get",
  tags: ["Blackouts"],
  summary: "List blocked date ranges",
  description:
    "Admin only. `GET /properties/{id}/availability` already tells a guest "
    + "which dates are taken, but it returns no ids and deliberately does not "
    + "carry the host's reason. This is what a calendar needs to offer "
    + "removal — and the reason is host-internal, which is why it is not on "
    + "the public endpoint.",
  middleware: [requireAuth, requireRole("admin"), rateLimits.read()],
  request: {
    query: listBlackoutsQuerySchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(listBlackoutsResponseSchema, "Blocked ranges"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(listBlackoutsQuerySchema),
      "The validation error(s)",
    ),
  },
});

export const removeBlackout = createRoute({
  path: "/blackouts/{id}",
  method: "delete",
  tags: ["Blackouts"],
  summary: "Put blocked dates back on sale",
  description:
    "Admin only. The nights become bookable immediately — nothing else holds "
    + "them, and no booking references a blackout. Without this, blocking "
    + "dates is a one-way door.",
  middleware: [requireAuth, requireRole("admin"), rateLimits.write()],
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.NO_CONTENT]: { description: "Blackout removed" },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Blackout not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(IdUUIDParamsSchema),
      "Invalid id",
    ),
  },
});

export type AvailabilityRoute = typeof availability;
export type CreateRoute = typeof create;
export type ListRoute = typeof list;
export type GetOneRoute = typeof getOne;
export type CancelRoute = typeof cancel;
export type CreateBlackoutRoute = typeof createBlackout;
export type ListBlackoutsRoute = typeof listBlackouts;
export type RemoveBlackoutRoute = typeof removeBlackout;
