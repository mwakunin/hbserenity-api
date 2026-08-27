import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db from "@/db";
import { bookings } from "@/db/schema";
import { dayFromNow, makeProperty, nextPhone, resetDb, signIn } from "@/test/helpers";

function validPropertyBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Nyali Sea View Apartment",
    description: "Two-bedroom apartment with a balcony overlooking the ocean.",
    propertyType: "apartment",
    status: "active",
    county: "Mombasa",
    town: "Nyali",
    maxGuests: 4,
    bedrooms: 2,
    bathrooms: 1,
    beds: 3,
    pricePerNightCents: 450_000,
    cleaningFeeCents: 100_000,
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/properties", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("properties routes", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("authorization", () => {
    it("rejects anonymous creation with 401", async () => {
      const res = await post(validPropertyBody());
      expect(res.status).toBe(401);
    });

    it("rejects a guest creating a property with 403", async () => {
      const guest = await signIn(nextPhone());
      const res = await post(validPropertyBody(), guest.headers);
      expect(res.status).toBe(403);
    });

    it("allows an admin to create a property", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(validPropertyBody(), admin.headers);
      expect(res.status).toBe(201);
    });

    it("rejects a guest patching a property with 403", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const guest = await signIn(nextPhone());
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...guest.headers },
        body: JSON.stringify({ title: "Hijacked" }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects a guest deleting a property with 403", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const guest = await signIn(nextPhone());
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`, {
        method: "DELETE",
        headers: guest.headers,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("create validation", () => {
    it("assigns hostId from the session, ignoring any client-sent value", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(
        validPropertyBody({ hostId: "someone-else" }),
        admin.headers,
      );

      expect(res.status).toBe(201);
      expect((await res.json()).hostId).toBe(admin.id);
    });

    it.each([
      ["title too short", { title: "ab" }],
      ["description too short", { description: "short" }],
      ["maxGuests zero", { maxGuests: 0 }],
      ["negative price", { pricePerNightCents: -100 }],
      ["latitude out of range", { latitude: 200 }],
      ["longitude out of range", { longitude: -400 }],
      ["invalid property type", { propertyType: "castle" }],
    ])("rejects %s with 422", async (_label, override) => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(validPropertyBody(override), admin.headers);
      expect(res.status).toBe(422);
    });

    it("rejects a price that is not a whole number of shillings", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(
        validPropertyBody({ pricePerNightCents: 12_345 }),
        admin.headers,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(JSON.stringify(json)).toMatch(/whole number of shillings/i);
    });

    it("accepts a price that is a whole number of shillings", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(
        validPropertyBody({ pricePerNightCents: 12_300 }),
        admin.headers,
      );
      expect(res.status).toBe(201);
    });
  });

  describe("bedrooms vs property type", () => {
    // `bedrooms` counts enclosed sleeping rooms, so a studio/bedsitter is 0.
    it("accepts a studio with 0 bedrooms", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(
        validPropertyBody({
          propertyType: "studio",
          bedrooms: 0,
          beds: 1,
          maxGuests: 2,
        }),
        admin.headers,
      );
      expect(res.status).toBe(201);
      expect((await res.json()).bedrooms).toBe(0);
    });

    it("rejects a studio claiming bedrooms", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(
        validPropertyBody({ propertyType: "studio", bedrooms: 2 }),
        admin.headers,
      );

      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/studio must have 0 bedrooms/i);
    });

    it.each(["apartment", "house", "villa", "cottage", "guesthouse"] as const)(
      "rejects a %s with 0 bedrooms",
      async (propertyType) => {
        const admin = await signIn(nextPhone(), "admin");
        const res = await post(
          validPropertyBody({ propertyType, bedrooms: 0 }),
          admin.headers,
        );
        expect(res.status).toBe(422);
      },
    );

    it("rejects a property with zero beds — it would sleep nobody", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(validPropertyBody({ beds: 0 }), admin.headers);
      expect(res.status).toBe(422);
    });

    it("accepts a bedsitter as a studio: 0 bedrooms, 1 bed, shared-ok bathroom", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await post(
        validPropertyBody({
          title: "Kilimani Bedsitter",
          propertyType: "studio",
          bedrooms: 0,
          bathrooms: 0,
          beds: 1,
          maxGuests: 1,
        }),
        admin.headers,
      );
      expect(res.status).toBe(201);
    });

    it("422s a PATCH that would break the rule — the DB CHECK is the backstop", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const created = await post(
        validPropertyBody({
          propertyType: "studio",
          bedrooms: 0,
          beds: 1,
          maxGuests: 2,
        }),
        admin.headers,
      );
      const { id } = await created.json();

      // Zod can't catch this: the patch body alone looks perfectly valid.
      const res = await app.request(`/properties/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({ bedrooms: 3 }),
      });

      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/studio must have 0 bedrooms/i);
    });

    it("allows a PATCH that changes type and bedrooms together", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const created = await post(
        validPropertyBody({
          propertyType: "studio",
          bedrooms: 0,
          beds: 1,
          maxGuests: 2,
        }),
        admin.headers,
      );
      const { id } = await created.json();

      const res = await app.request(`/properties/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({ propertyType: "apartment", bedrooms: 1 }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).propertyType).toBe("apartment");
    });
  });

  describe("public listing", () => {
    it("is reachable without authentication", async () => {
      const res = await app.request("/properties");
      expect(res.status).toBe(200);
    });

    it("hides draft and inactive properties from the public list", async () => {
      const admin = await signIn(nextPhone(), "admin");
      await makeProperty(admin.id, { title: "Active one", status: "active" });
      await makeProperty(admin.id, { title: "Draft one", status: "draft" });
      await makeProperty(admin.id, { title: "Inactive one", status: "inactive" });

      const res = await app.request("/properties");
      const { data, meta } = await res.json();

      expect(meta.total).toBe(1);
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe("Active one");
    });

    it("404s a draft property for an anonymous visitor", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const draft = await makeProperty(admin.id, { status: "draft" });

      const res = await app.request(`/properties/${draft.id}`);
      expect(res.status).toBe(404);
    });

    it("lets an admin fetch their own draft property", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const draft = await makeProperty(admin.id, { status: "draft" });

      const res = await app.request(`/properties/${draft.id}`, {
        headers: admin.headers,
      });
      expect(res.status).toBe(200);
    });

    it("404s an unknown id", async () => {
      const res = await app.request(
        "/properties/4651e634-a530-4484-9b09-9616a28f35e3",
      );
      expect(res.status).toBe(404);
    });

    it("422s a malformed uuid", async () => {
      const res = await app.request("/properties/not-a-uuid");
      expect(res.status).toBe(422);
    });

    it("returns images and amenities arrays on the detail view", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`);
      const json = await res.json();

      expect(json.images).toEqual([]);
      expect(json.amenities).toEqual([]);
    });
  });

  describe("filters and pagination", () => {
    beforeEach(async () => {
      const admin = await signIn(nextPhone(), "admin");
      await makeProperty(admin.id, {
        title: "Diani villa",
        county: "Kwale",
        town: "Diani",
        maxGuests: 6,
        pricePerNightCents: 850_000,
        propertyType: "villa",
      });
      await makeProperty(admin.id, {
        title: "Nyali flat",
        county: "Mombasa",
        town: "Nyali",
        maxGuests: 2,
        pricePerNightCents: 300_000,
        propertyType: "apartment",
      });
      await makeProperty(admin.id, {
        title: "Karen cottage",
        county: "Nairobi",
        town: "Karen",
        maxGuests: 4,
        pricePerNightCents: 500_000,
        propertyType: "cottage",
      });
    });

    it("filters by county", async () => {
      const res = await app.request("/properties?county=Kwale");
      const { data } = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe("Diani villa");
    });

    it("filters by town", async () => {
      const res = await app.request("/properties?town=Nyali");
      const { data } = await res.json();
      expect(data).toHaveLength(1);
    });

    it("filters by property type", async () => {
      const res = await app.request("/properties?propertyType=cottage");
      const { data } = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe("Karen cottage");
    });

    it("filters by minimum guest capacity", async () => {
      const res = await app.request("/properties?minGuests=4");
      const { data } = await res.json();
      expect(data.map((p: { title: string }) => p.title).sort())
        .toEqual(["Diani villa", "Karen cottage"]);
    });

    it("filters by maximum price", async () => {
      const res = await app.request("/properties?maxPriceCents=500000");
      const { data } = await res.json();
      expect(data).toHaveLength(2);
    });

    it("combines filters", async () => {
      const res = await app.request("/properties?county=Nairobi&minGuests=4");
      const { data } = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe("Karen cottage");
    });

    it("paginates and reports accurate meta", async () => {
      const res = await app.request("/properties?page=1&limit=2");
      const { data, meta } = await res.json();

      expect(data).toHaveLength(2);
      expect(meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    });

    it("returns the remainder on the last page", async () => {
      const res = await app.request("/properties?page=2&limit=2");
      const { data } = await res.json();
      expect(data).toHaveLength(1);
    });

    it("returns an empty page past the end rather than erroring", async () => {
      const res = await app.request("/properties?page=99&limit=2");
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });

    it("422s a non-positive page", async () => {
      const res = await app.request("/properties?page=0");
      expect(res.status).toBe(422);
    });

    it("422s a limit above the cap", async () => {
      const res = await app.request("/properties?limit=500");
      expect(res.status).toBe(422);
    });
  });

  describe("patch", () => {
    it("updates a single field", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({ title: "Renamed villa" }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).title).toBe("Renamed villa");
    });

    it("moves updatedAt forward", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({ title: "Touched" }),
      });

      const updated = await res.json();
      expect(new Date(updated.updatedAt).getTime())
        .toBeGreaterThan(new Date(property.updatedAt).getTime());
    });

    it("422s an empty patch body", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("404s an unknown property", async () => {
      const admin = await signIn(nextPhone(), "admin");

      const res = await app.request(
        "/properties/4651e634-a530-4484-9b09-9616a28f35e3",
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...admin.headers },
          body: JSON.stringify({ title: "Nowhere" }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("delete", () => {
    it("deletes a property with no bookings", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);

      const res = await app.request(`/properties/${property.id}`, {
        method: "DELETE",
        headers: admin.headers,
      });
      expect(res.status).toBe(204);

      const after = await app.request(`/properties/${property.id}`);
      expect(after.status).toBe(404);
    });

    it("409s when the property has bookings, preserving history", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const guest = await signIn(nextPhone());
      const property = await makeProperty(admin.id);

      await db.insert(bookings).values({
        propertyId: property.id,
        guestId: guest.id,
        checkIn: dayFromNow(10),
        checkOut: dayFromNow(13),
        guestCount: 2,
        totalAmountCents: 2_550_000,
      });

      const res = await app.request(`/properties/${property.id}`, {
        method: "DELETE",
        headers: admin.headers,
      });
      expect(res.status).toBe(409);
    });

    it("404s an unknown property", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const res = await app.request(
        "/properties/4651e634-a530-4484-9b09-9616a28f35e3",
        { method: "DELETE", headers: admin.headers },
      );
      expect(res.status).toBe(404);
    });
  });
});
