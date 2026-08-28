import { and, asc, eq, ne } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { properties, propertyImages } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { deleteFile, imagekitEnabled, isOwnCdnUrl, uploadAuth } from "@/lib/imagekit";

import type {
  AttachRoute,
  CreateUploadAuthRoute,
  ListForPropertyRoute,
  PatchRoute,
  RemoveRoute,
} from "./images.routes";

const NOT_CONFIGURED = {
  message: "Image hosting is not configured on this deployment",
} as const;

async function propertyExists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, id));

  return Boolean(row);
}

export const createUploadAuth: AppRouteHandler<CreateUploadAuthRoute> = async (c) => {
  const { id } = c.req.valid("param");

  if (!imagekitEnabled)
    return c.json(NOT_CONFIGURED, HttpStatusCodes.CONFLICT);

  // Checked before signing, so a signature is never handed out for a listing
  // that does not exist.
  if (!await propertyExists(id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(uploadAuth(), HttpStatusCodes.OK);
};

export const attach: AppRouteHandler<AttachRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { url, fileId, order, isCover } = c.req.valid("json");

  if (!imagekitEnabled)
    return c.json(NOT_CONFIGURED, HttpStatusCodes.CONFLICT);

  if (!await propertyExists(id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // The client reports where the file landed. Unchecked, that lets a listing
  // be pointed at any host on the internet — including one that serves
  // something else later.
  if (!isOwnCdnUrl(url)) {
    return c.json(
      {
        success: false,
        error: {
          issues: [{
            code: "custom",
            path: ["url"],
            message: "The url must point at this deployment's ImageKit endpoint",
          }],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  try {
    const created = await db.transaction(async (tx) => {
      // One cover per property. Cleared first so the partial unique index sees
      // a single candidate; two concurrent requests still cannot both win,
      // which is what the index is for.
      if (isCover) {
        await tx.update(propertyImages)
          .set({ isCover: false })
          .where(eq(propertyImages.propertyId, id));
      }

      const [row] = await tx.insert(propertyImages).values({
        propertyId: id,
        url,
        fileId,
        order: order ?? 0,
        isCover: isCover ?? false,
      }).returning();

      return row;
    });

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    // property_images_file_id_idx: the same upload submitted twice is a
    // duplicate, not a second photo.
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That file is already attached to a listing" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const listForProperty: AppRouteHandler<ListForPropertyRoute> = async (c) => {
  const { id } = c.req.valid("param");

  if (!await propertyExists(id)) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const data = await db.select()
    .from(propertyImages)
    .where(eq(propertyImages.propertyId, id))
    .orderBy(asc(propertyImages.order), asc(propertyImages.createdAt));

  return c.json({ data }, HttpStatusCodes.OK);
};

export const patch: AppRouteHandler<PatchRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  try {
    return await setImage(c, id, body);
  }
  catch (err) {
    // property_images_one_cover_idx, if two promotions interleave past the
    // clear-then-set above.
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "Another photo was made the cover at the same time" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

async function setImage(
  c: Parameters<AppRouteHandler<PatchRoute>>[0],
  id: string,
  body: { order?: number; isCover?: boolean },
) {
  const updated = await db.transaction(async (tx) => {
    const [existing] = await tx.select({ propertyId: propertyImages.propertyId })
      .from(propertyImages)
      .where(eq(propertyImages.id, id));

    if (!existing)
      return null;

    // Demote the current cover before promoting this one, or the partial
    // unique index rejects the update.
    if (body.isCover) {
      await tx.update(propertyImages)
        .set({ isCover: false })
        .where(and(
          eq(propertyImages.propertyId, existing.propertyId),
          ne(propertyImages.id, id),
        ));
    }

    const [row] = await tx.update(propertyImages)
      .set(body)
      .where(eq(propertyImages.id, id))
      .returning();

    return row ?? null;
  });

  if (!updated) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(updated, HttpStatusCodes.OK);
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [image] = await db.select()
    .from(propertyImages)
    .where(eq(propertyImages.id, id));

  if (!image) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // The CDN copy goes first. Dropping the row on a failed delete would leave a
  // file nothing references and no id to find it by — billed forever. A 404
  // from ImageKit counts as success, so a retry after a partial failure works.
  try {
    await deleteFile(image.fileId);
  }
  catch (err) {
    c.var.logger.error(
      { err, imageId: id, fileId: image.fileId },
      "ImageKit would not delete the file; keeping the record",
    );

    return c.json(
      { message: "The image could not be deleted from the CDN, so it was kept" },
      HttpStatusCodes.BAD_GATEWAY,
    );
  }

  await db.delete(propertyImages).where(eq(propertyImages.id, id));

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
