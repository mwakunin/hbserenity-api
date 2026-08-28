import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { propertyImages } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const selectImageSchema = toZodV4SchemaTyped(
  createSelectSchema(propertyImages),
);

/**
 * What the client needs to upload straight to ImageKit.
 *
 * The signature authorises an upload into this account, so it is admin-only
 * and short-lived. It is not a URL the browser can be pointed at — the client
 * posts it to ImageKit's own upload endpoint along with the file.
 */
export const uploadAuthResponseSchema = z.object({
  token: z.string().openapi({ example: "8f3a1e4c-1c2b-4c9a-9b7e-0d5b6a2f1c33" }),
  expire: z.number().int().openapi({ example: 1_775_000_000 }),
  signature: z.string().openapi({ example: "0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90" }),
  publicKey: z.string().openapi({ example: "public_aBcDeF123456" }),
  urlEndpoint: z.string().openapi({ example: "https://ik.imagekit.io/hbserenity" }),
});

/**
 * Recording a file the client has already uploaded.
 *
 * `fileId` is required rather than derived from the URL: it is ImageKit's
 * handle for the file and the only way to delete it later. Without it a
 * removed image stays on the CDN forever, billed and unreferenced.
 */
export const attachImageSchema = z.object({
  url: z.url().openapi({ example: "https://ik.imagekit.io/hbserenity/diani-1.jpg" }),
  fileId: z.string().trim().min(1).max(128).openapi({ example: "6a1f...c92" }),
  order: z.number().int().nonnegative().optional().openapi({ example: 0 }),
  isCover: z.boolean().optional().openapi({ example: true }),
});

/** Reordering a gallery, or moving the cover to a different photo. */
export const patchImageSchema = z.object({
  order: z.number().int().nonnegative().optional(),
  isCover: z.boolean().optional(),
}).refine(
  body => body.order !== undefined || body.isCover !== undefined,
  { message: "Provide at least one of order or isCover" },
);

export const listImagesResponseSchema = z.object({
  data: z.array(selectImageSchema),
});
