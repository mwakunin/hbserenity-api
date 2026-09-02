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
  insertAmenitySchema,
  listAmenitiesResponseSchema,
  selectAmenitySchema,
  setPropertyAmenitiesSchema,
} from "./amenities.schemas";

const tags = ["Amenities"];

const adminOnly = () => [requireAuth, requireRole("admin"), rateLimits.write()];

export const list = createRoute({
  path: "/amenities",
  method: "get",
  tags,
  summary: "List the amenity catalogue",
  description:
    "Public. The vocabulary a listing picks from — every amenity that can be "
    + "attached to a property, whether or not any listing has it. This is what "
    + "populates a picker in the admin editor; the amenities a particular "
    + "listing has come back on `GET /properties/{id}`.",
  middleware: [rateLimits.read()],
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(listAmenitiesResponseSchema, "The catalogue"),
  },
});

export const create = createRoute({
  path: "/amenities",
  method: "post",
  tags,
  summary: "Add an amenity to the catalogue",
  description:
    "Admin only. Names are unique, so adding one that already exists is a "
    + "409 rather than a second pickable entry meaning the same thing.",
  middleware: adminOnly(),
  request: {
    body: jsonContentRequired(insertAmenitySchema, "The amenity"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.CREATED]: jsonContent(selectAmenitySchema, "The created amenity"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.CONFLICT]: jsonContent(conflictSchema, "That amenity already exists"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(insertAmenitySchema),
      "The validation error(s)",
    ),
  },
});

export const setForProperty = createRoute({
  path: "/properties/{id}/amenities",
  method: "put",
  tags,
  summary: "Replace the amenities on a listing",
  description:
    "Admin only. The body is the complete set the listing ends up with, not a "
    + "change to apply, so re-submitting a form is idempotent and unticking a "
    + "box needs no separate call. Repeated ids are ignored. An id that is not "
    + "in the catalogue is a 422 and nothing is changed.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(setPropertyAmenitiesSchema, "The complete set"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(listAmenitiesResponseSchema, "The listing's amenities"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(setPropertyAmenitiesSchema),
      "The validation error(s)",
    ),
  },
});

export type ListRoute = typeof list;
export type CreateRoute = typeof create;
export type SetForPropertyRoute = typeof setForProperty;
