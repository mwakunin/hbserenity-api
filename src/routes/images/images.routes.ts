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
  attachImageSchema,
  listImagesResponseSchema,
  patchImageSchema,
  selectImageSchema,
  uploadAuthResponseSchema,
} from "./images.schemas";

const tags = ["Images"];

const adminOnly = () => [requireAuth, requireRole("admin"), rateLimits.write()];

/** ImageKit is configured per environment; without it these cannot work. */
const notConfigured = jsonContent(
  conflictSchema,
  "Image hosting is not configured on this deployment",
);

export const createUploadAuth = createRoute({
  path: "/properties/{id}/images/upload-auth",
  method: "post",
  tags,
  summary: "Get credentials for a direct upload",
  description:
    "Admin only. Returns a short-lived signature the client sends to "
    + "ImageKit along with the file, so the bytes never pass through this "
    + "API. Post the resulting url and fileId back to "
    + "`POST /properties/{id}/images` to attach it to the listing.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(uploadAuthResponseSchema, "Upload credentials"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: notConfigured,
  },
});

export const attach = createRoute({
  path: "/properties/{id}/images",
  method: "post",
  tags,
  summary: "Attach an uploaded photo to a listing",
  description:
    "Admin only. The url must point at this account's own ImageKit endpoint "
    + "— an unchecked url would let a listing be pointed anywhere on the "
    + "internet. Setting isCover moves the cover from whichever photo held it.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(attachImageSchema, "The uploaded file"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.CREATED]: jsonContent(selectImageSchema, "The attached image"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "That file is already attached, or image hosting is not configured",
    ),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
      conflictSchema,
      "ImageKit could not be reached to verify the upload",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(attachImageSchema),
      "The validation error(s)",
    ),
  },
});

export const listForProperty = createRoute({
  path: "/properties/{id}/images",
  method: "get",
  tags,
  summary: "Photos on a listing",
  description: "Admin only — the public listing already carries its images.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(listImagesResponseSchema, "The images"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Property not found"),
  },
});

export const patch = createRoute({
  path: "/property-images/{id}",
  method: "patch",
  tags,
  summary: "Reorder a photo, or make it the cover",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(patchImageSchema, "The change"),
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.OK]: jsonContent(selectImageSchema, "The updated image"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Image not found"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      conflictSchema,
      "Another photo was made the cover at the same time",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(patchImageSchema),
      "The validation error(s)",
    ),
  },
});

export const remove = createRoute({
  path: "/property-images/{id}",
  method: "delete",
  tags,
  summary: "Remove a photo",
  description:
    "Deletes the file from ImageKit first, then the record. If ImageKit "
    + "refuses, the record is kept and this returns 502 — dropping the row "
    + "anyway would strand a file on the CDN that nothing references.",
  middleware: adminOnly(),
  request: {
    params: IdUUIDParamsSchema,
  },
  responses: {
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Rate limit exceeded"),
    [HttpStatusCodes.NO_CONTENT]: { description: "Image removed" },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "Image not found"),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
      conflictSchema,
      "ImageKit would not delete the file, so the record was kept",
    ),
  },
});

export type CreateUploadAuthRoute = typeof createUploadAuth;
export type AttachRoute = typeof attach;
export type ListForPropertyRoute = typeof listForProperty;
export type PatchRoute = typeof patch;
export type RemoveRoute = typeof remove;
