import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import { forbiddenSchema, notFoundSchema, tooManyRequestsSchema, unauthorizedSchema } from "@/lib/constants";
import { requireAuth, requireRole } from "@/middlewares/auth";
import { rateLimits } from "@/middlewares/rate-limit";

import {
  insertPropertySchema,
  listPropertiesQuerySchema,
  listPropertiesResponseSchema,
  patchPropertySchema,
  propertyWithImagesSchema,
  selectPropertySchema,
} from "./properties.schemas";

const tags = ["Properties"];

/**
 * Admin-only mutation guard for every write route below. A function rather
 * than a shared array so each route gets its own mutable instance — Hono's
 * `middleware` field rejects a readonly tuple.
 */
const adminOnly = () => [requireAuth, requireRole("admin"), rateLimits.write()];

export const list = createRoute({
  path: "/properties",
  method: "get",
  tags,
  summary: "Browse active listings",
  description:
    "Public. Only returns properties with status 'active' — drafts and "
    + "deactivated listings are never exposed here.",
  middleware: [rateLimits.read()],
  request: {
    query: listPropertiesQuerySchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(
      listPropertiesResponseSchema,
      "A page of active properties",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(listPropertiesQuerySchema),
      "Invalid filter(s)",
    ),
  },
});

export const getOne = createRoute({
  path: "/properties/{id}",
  method: "get",
  tags,
  summary: "Get one listing with its images and amenities",
  middleware: [rateLimits.read()],
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(propertyWithImagesSchema, "The property"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(IdUUIDParamsSchema),
      "Invalid id",
    ),
  },
});

export const create = createRoute({
  path: "/properties",
  method: "post",
  tags,
  summary: "Create a listing",
  middleware: adminOnly(),
  request: {
    body: jsonContentRequired(insertPropertySchema, "The property to create"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.CREATED]: jsonContent(selectPropertySchema, "The created property"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(insertPropertySchema),
      "The validation error(s)",
    ),
  },
});

export const patch = createRoute({
  path: "/properties/{id}",
  method: "patch",
  tags,
  summary: "Update a listing",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(patchPropertySchema, "The updates"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.OK]: jsonContent(selectPropertySchema, "The updated property"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(patchPropertySchema).or(createErrorSchema(IdUUIDParamsSchema)),
      "The validation error(s)",
    ),
  },
});

export const remove = createRoute({
  path: "/properties/{id}",
  method: "delete",
  tags,
  summary: "Delete a listing",
  description:
    "Fails with 409 if the property has bookings — booking history must "
    + "survive. Deactivate the listing instead.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Rate limit exceeded",
    ),
    [HttpStatusCodes.NO_CONTENT]: { description: "Property deleted" },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "The property has bookings and cannot be deleted",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(IdUUIDParamsSchema),
      "Invalid id",
    ),
  },
});

export type ListRoute = typeof list;
export type GetOneRoute = typeof getOne;
export type CreateRoute = typeof create;
export type PatchRoute = typeof patch;
export type RemoveRoute = typeof remove;
