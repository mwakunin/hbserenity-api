import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  conflictSchema,
  forbiddenSchema,
  notFoundSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireAuth, requireRole } from "@/middlewares/auth";

import {
  availabilityQuerySchema,
  availabilityResponseSchema,
  createBlackoutSchema,
  createBookingSchema,
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
  responses: {
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
  middleware: [requireAuth],
  request: {
    body: jsonContentRequired(createBookingSchema, "The booking to create"),
  },
  responses: {
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
  middleware: [requireAuth],
  request: {
    query: listBookingsQuerySchema,
  },
  responses: {
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
  middleware: [requireAuth],
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
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
    "Only a booking still in pending_payment may be cancelled, per the "
    + "status lifecycle. Cancelling frees the dates for another guest.",
  middleware: [requireAuth],
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(selectBookingSchema, "The cancelled booking"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not your booking"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Booking not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "This booking can no longer be cancelled",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(IdUUIDParamsSchema),
      "Invalid id",
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
    + "without creating a fake booking.",
  middleware: [requireAuth, requireRole("admin")],
  request: {
    body: jsonContentRequired(createBlackoutSchema, "The blackout to create"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      selectBlackoutSchema,
      "The created blackout",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "Overlaps an existing blackout",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createBlackoutSchema),
      "The validation error(s)",
    ),
  },
});

export type AvailabilityRoute = typeof availability;
export type CreateRoute = typeof create;
export type ListRoute = typeof list;
export type GetOneRoute = typeof getOne;
export type CancelRoute = typeof cancel;
export type CreateBlackoutRoute = typeof createBlackout;
