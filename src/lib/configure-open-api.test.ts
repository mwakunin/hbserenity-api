import { describe, expect, it } from "vitest";

import app from "@/app";

/**
 * The OpenAPI document, generated from the same zod schemas the routes
 * validate with.
 *
 * This is the seam `toZodV4SchemaTyped` bridges, and it bridges it with an
 * `as unknown as` cast — TypeScript is explicitly told to stop checking there,
 * so a zod or drizzle-zod change that broke schema serialisation would not
 * fail the build. It would not fail the route tests either: those exercise
 * validation, which keeps working even if the *description* of a schema comes
 * out empty. The docs are a shipped feature, so the description is worth
 * asserting on its own.
 */
describe("the OpenAPI document", () => {
  it("serves a document covering every route group", async () => {
    const res = await app.request("/doc");
    expect(res.status).toBe(200);

    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\./);

    const paths = Object.keys(spec.paths ?? {});
    // Every group is represented: properties, bookings, payments, reviews,
    // rates, images, admin.
    for (const path of [
      "/properties",
      "/properties/{id}/quote",
      "/properties/{id}/images",
      "/bookings",
      "/bookings/{id}/cancel",
      "/mpesa/callback",
      "/admin/payments/reconcile",
    ]) {
      expect(paths).toContain(path);
    }
  });

  // An empty or constraint-free schema is the failure mode to catch: the API
  // keeps rejecting bad input, but the documentation stops saying what "bad"
  // means, and a client written against it gets 422s it cannot explain.
  it("renders request bodies with their constraints intact", async () => {
    const spec = await (await app.request("/doc")).json();
    const body = spec.paths["/bookings/{id}/cancel"].post
      .requestBody
      .content["application/json"]
      .schema;

    expect(body.type).toBe("object");
    expect(body.properties.reason).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 500,
    });
  });

  it("renders query parameters rather than dropping them", async () => {
    const spec = await (await app.request("/doc")).json();
    const params = spec.paths["/properties/{id}/quote"].get.parameters;

    const names = params.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["id", "checkIn", "checkOut"]));
  });

  /**
   * The composed case, which is the one the cast is actually awkward about.
   *
   * The assertion below covers a plain pass-through — drizzle-zod output
   * wrapped and nothing else. `propertyWithImagesSchema` instead `.extend()`s
   * that output with `zod/v4` arrays and objects before wrapping, which is why
   * CLAUDE.md insists composition happens *before* `toZodV4SchemaTyped`: the
   * cast throws `.shape` away. A regression confined to that mixture would
   * degrade the documented `GET /properties/{id}` response — the main public
   * listing detail — while every other assertion here stayed green.
   */
  it("renders a schema that mixes drizzle-zod output with hand-written zod", async () => {
    const spec = await (await app.request("/doc")).json();
    const schema = spec.paths["/properties/{id}"].get
      .responses["200"]
      .content["application/json"]
      .schema;

    // The table half survived the extend.
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "title", "pricePerNightCents", "images", "amenities"]),
    );

    // A nested drizzle-zod schema, not collapsed to an untyped array.
    expect(schema.properties.images.type).toBe("array");
    expect(Object.keys(schema.properties.images.items?.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "url", "fileId", "isCover"]),
    );

    // And the hand-written zod/v4 half beside it.
    expect(schema.properties.amenities.type).toBe("array");
    expect(Object.keys(schema.properties.amenities.items?.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "name", "icon"]),
    );
  });

  // Derived from drizzle-zod, so this is the path that actually crosses the
  // cast: a table definition turned into a response schema.
  it("renders a response schema derived from a table", async () => {
    const spec = await (await app.request("/doc")).json();
    const schema = spec.paths["/bookings/{id}/cancel"].post
      .responses["200"]
      .content["application/json"]
      .schema;

    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "status", "checkIn", "checkOut", "totalAmountCents"]),
    );
  });
});
