import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db from "@/db";
import { bookings, propertyImages } from "@/db/schema";
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

    // A host could create a listing and then find it in no list at all — the
    // id was the only way back to it.
    it("lets an admin see their own drafts, without changing what a guest sees", async () => {
      const admin = await signIn(nextPhone(), "admin");
      await makeProperty(admin.id, { title: "Active one", status: "active" });
      await makeProperty(admin.id, { title: "Draft one", status: "draft" });

      const asGuest = await (await app.request("/properties")).json();
      expect(asGuest.data.map((p: { title: string }) => p.title)).toEqual(["Active one"]);

      // Default is unchanged for an admin too: seeing drafts is opt-in, so
      // browsing the site as one shows the same listings a guest gets.
      const adminDefault = await (await app.request("/properties", { headers: admin.headers })).json();
      expect(adminDefault.data.map((p: { title: string }) => p.title)).toEqual(["Active one"]);

      const all = await (await app.request("/properties?status=all", { headers: admin.headers })).json();
      expect(all.data.map((p: { title: string }) => p.title).sort()).toEqual(["Active one", "Draft one"]);

      const drafts = await (await app.request("/properties?status=draft", { headers: admin.headers })).json();
      expect(drafts.data.map((p: { title: string }) => p.title)).toEqual(["Draft one"]);
    });

    // The floor is unconditional: widening is the exception, so a mistake
    // leaves the public list too strict rather than leaking a draft.
    it.each(["all", "draft", "inactive"])(
      "ignores status=%s from a guest rather than honouring it",
      async (status) => {
        const admin = await signIn(nextPhone(), "admin");
        const guest = await signIn(nextPhone());
        await makeProperty(admin.id, { title: "Active one", status: "active" });
        await makeProperty(admin.id, { title: "Draft one", status: "draft" });

        for (const headers of [undefined, guest.headers]) {
          const res = await app.request(`/properties?status=${status}`, headers ? { headers } : undefined);
          const { data } = await res.json();
          expect(data.map((p: { title: string }) => p.title)).toEqual(["Active one"]);
        }
      },
    );

    // Same URL, two different answers. A shared cache keyed on the URL would
    // store the admin's copy and replay it to anonymous visitors — and the
    // session is a cookie, so the Authorization-header rule that normally
    // keeps shared caches off authenticated responses does not apply here.
    describe("cacheability of the admin view", () => {
      it.each(["all", "draft", "inactive"])(
        "marks status=%s no-store, since it cannot be shared with a guest",
        async (status) => {
          const admin = await signIn(nextPhone(), "admin");
          await makeProperty(admin.id, { title: "Active one", status: "active" });
          await makeProperty(admin.id, { title: "Draft one", status: "draft" });

          const url = `/properties?status=${status}`;

          const asAdmin = await app.request(url, { headers: admin.headers });
          const asGuest = await app.request(url);

          // The two answers differ, which is what makes sharing them a leak.
          const adminTitles = (await asAdmin.json()).data.map((p: { title: string }) => p.title);
          const guestTitles = (await asGuest.json()).data.map((p: { title: string }) => p.title);
          expect(adminTitles).not.toEqual(guestTitles);
          expect(guestTitles).toEqual(["Active one"]);

          expect(asAdmin.headers.get("cache-control")).toBe("no-store");
        },
      );

      // Precision matters both ways: marking every list response no-store
      // would make the public browse grid uncacheable for no reason.
      it.each([
        ["the default", ""],
        ["an explicit status=active", "?status=active"],
      ])("does not set no-store on %s", async (_label, query) => {
        const admin = await signIn(nextPhone(), "admin");
        await makeProperty(admin.id, { status: "active" });

        const asAdmin = await app.request(`/properties${query}`, { headers: admin.headers });
        const asGuest = await app.request(`/properties${query}`);

        expect(asAdmin.headers.get("cache-control")).toBeNull();
        expect(asGuest.headers.get("cache-control")).toBeNull();
      });
    });

    // Without this the browse grid has no photos: the only way to get one was
    // a request per listing.
    describe("cover image", () => {
      it("carries the cover so a grid needs no request per card", async () => {
        const admin = await signIn(nextPhone(), "admin");
        const property = await makeProperty(admin.id);

        await db.insert(propertyImages).values([
          { propertyId: property.id, url: "https://cdn.test/b.jpg", fileId: "b", order: 1, isCover: false },
          { propertyId: property.id, url: "https://cdn.test/a.jpg", fileId: "a", order: 2, isCover: true },
        ]);

        const { data } = await (await app.request("/properties")).json();
        expect(data[0].coverImage.url).toBe("https://cdn.test/a.jpg");
      });

      // A host can upload photos and never pick one. Falling back means the
      // listing still shows a picture rather than looking photoless.
      it("falls back to the lowest order when no cover is set", async () => {
        const admin = await signIn(nextPhone(), "admin");
        const property = await makeProperty(admin.id);

        await db.insert(propertyImages).values([
          { propertyId: property.id, url: "https://cdn.test/second.jpg", fileId: "s", order: 5, isCover: false },
          { propertyId: property.id, url: "https://cdn.test/first.jpg", fileId: "f", order: 1, isCover: false },
        ]);

        const { data } = await (await app.request("/properties")).json();
        expect(data[0].coverImage.url).toBe("https://cdn.test/first.jpg");
      });

      // The database picks the cover now, so two photos sharing an `order`
      // need a tiebreaker or the answer is whichever row the scan reaches
      // first — insertion order today, something else after a vacuum or a
      // plan change, and the grid flaps for a listing nobody touched. The
      // ids here are fixed so the lowest one is NOT the first inserted:
      // without the tiebreaker this returns the other photo.
      it("breaks an order tie on id rather than on scan order", async () => {
        const admin = await signIn(nextPhone(), "admin");
        const property = await makeProperty(admin.id);

        await db.insert(propertyImages).values([
          {
            id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
            propertyId: property.id,
            url: "https://cdn.test/inserted-first.jpg",
            fileId: "tie-high-id",
            order: 0,
            isCover: false,
          },
          {
            id: "00000000-0000-4000-8000-000000000000",
            propertyId: property.id,
            url: "https://cdn.test/lowest-id.jpg",
            fileId: "tie-low-id",
            order: 0,
            isCover: false,
          },
        ]);

        const { data } = await (await app.request("/properties")).json();
        expect(data[0].coverImage.url).toBe("https://cdn.test/lowest-id.jpg");
      });

      it("is null for a listing with no photos", async () => {
        const admin = await signIn(nextPhone(), "admin");
        await makeProperty(admin.id);

        const { data } = await (await app.request("/properties")).json();
        expect(data[0].coverImage).toBeNull();
      });

      // Only the cover, not the gallery: a host can upload any number of
      // photos, and the size of this response must not depend on that.
      it("carries one image, not the whole gallery", async () => {
        const admin = await signIn(nextPhone(), "admin");
        const property = await makeProperty(admin.id);

        await db.insert(propertyImages).values(
          Array.from({ length: 5 }, (_, i) => ({
            propertyId: property.id,
            url: `https://cdn.test/${i}.jpg`,
            fileId: `f${i}`,
            order: i,
            isCover: i === 0,
          })),
        );

        const { data } = await (await app.request("/properties")).json();
        expect(data[0].coverImage.url).toBe("https://cdn.test/0.jpg");
        expect(data[0].images).toBeUndefined();
      });

      // The images relation is a lateral subquery limited to one row per
      // listing, not a join, so a listing with many photos must still be one
      // row in the page.
      it("does not duplicate a listing that has several photos", async () => {
        const admin = await signIn(nextPhone(), "admin");
        const property = await makeProperty(admin.id);

        await db.insert(propertyImages).values(
          Array.from({ length: 4 }, (_, i) => ({
            propertyId: property.id,
            url: `https://cdn.test/${i}.jpg`,
            fileId: `dup${i}`,
            order: i,
            isCover: false,
          })),
        );

        const { data, meta } = await (await app.request("/properties")).json();
        expect(data).toHaveLength(1);
        expect(meta.total).toBe(1);
      });
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

    // The draft response depends on who is asking — a shared cache must not
    // store the admin's copy and replay it to anonymous visitors.
    it("marks a draft response no-store, since visibility depends on the caller", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const draft = await makeProperty(admin.id, { status: "draft" });

      const res = await app.request(`/properties/${draft.id}`, {
        headers: admin.headers,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("does not set no-store on a public active listing", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id, { status: "active" });

      const res = await app.request(`/properties/${property.id}`);
      expect(res.headers.get("cache-control")).toBeNull();
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

    const titles = async (query: string) =>
      (await (await app.request(`/properties${query}`)).json())
        .data
        .map((p: { title: string }) => p.title);

    /*
     * Fixture prices: Diani 850,000c · Nyali 300,000c · Karen 500,000c,
     * inserted in that order.
     */
    describe("sorting", () => {
      // Newest first, not oldest — a browse grid leads with what was just
      // listed. This is a change: the endpoint used to return them in the
      // order they were created, and nothing pinned it.
      it("defaults to newest first", async () => {
        expect(await titles("")).toEqual(["Karen cottage", "Nyali flat", "Diani villa"]);
      });

      it("orders by price ascending", async () => {
        expect(await titles("?sort=price_asc"))
          .toEqual(["Nyali flat", "Karen cottage", "Diani villa"]);
      });

      it("orders by price descending", async () => {
        expect(await titles("?sort=price_desc"))
          .toEqual(["Diani villa", "Karen cottage", "Nyali flat"]);
      });

      it("sorts the filtered set, not the whole catalogue", async () => {
        expect(await titles("?minGuests=4&sort=price_asc"))
          .toEqual(["Karen cottage", "Diani villa"]);
      });

      // A free-form column name would be an injection surface and a promise
      // to keep ordering by whatever anyone once passed.
      it("422s an ordering it does not offer", async () => {
        const res = await app.request("/properties?sort=price_per_night_cents");
        expect(res.status).toBe(422);
      });

      /*
       * Price is not unique, so paging a tied set needs the id tiebreaker or
       * a listing can appear on two pages and another on none. The ids are
       * fixed so the lowest is inserted last: without the tiebreaker the
       * pages come back in insertion order, which is the reverse.
       */
      it("pages tied prices in a stable order", async () => {
        const admin = await signIn(nextPhone(), "admin");
        const ids = [
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ];
        for (const id of ids)
          await makeProperty(admin.id, { id, title: `Tied ${id[0]}`, pricePerNightCents: 100_000 });

        const paged: string[] = [];
        for (let page = 1; page <= 3; page++) {
          const { data } = await (await app.request(
            `/properties?sort=price_asc&maxPriceCents=100000&page=${page}&limit=1`,
          )).json();
          paged.push(...data.map((p: { id: string }) => p.id));
        }

        expect(paged).toEqual([...ids].sort());
        expect(new Set(paged).size).toBe(3);
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
  describe("availability filter", () => {
    let admin: { id: string; headers: Record<string, string> };
    let guestId: string;
    let taken: { id: string };

    async function hold(propertyId: string, checkIn: string, checkOut: string) {
      await db.insert(bookings).values({
        propertyId,
        guestId,
        checkIn,
        checkOut,
        guestCount: 2,
        totalAmountCents: 2_550_000,
      });
    }

    async function search(query: string) {
      const res = await app.request(`/properties?${query}`);
      return { status: res.status, body: await res.json() };
    }

    beforeEach(async () => {
      admin = await signIn(nextPhone(), "admin");
      const guest = await signIn(nextPhone());
      guestId = guest.id;
      // Kept unbound: it is the listing every search must still return.
      await makeProperty(admin.id, { title: "Free one" });
      taken = await makeProperty(admin.id, { title: "Taken one" });
    });

    it("hides a listing booked across the requested dates", async () => {
      await hold(taken.id, dayFromNow(10), dayFromNow(15));

      const { body } = await search(`checkIn=${dayFromNow(11)}&checkOut=${dayFromNow(13)}`);

      expect(body.data.map((p: { title: string }) => p.title)).toEqual(["Free one"]);
      expect(body.meta.total).toBe(1);
    });

    // Half-open, exactly as the booking constraint treats it: the checkout day
    // is on sale again. Getting this wrong makes back-to-back stays unfindable.
    it("still offers a listing whose stay ends on the requested check-in", async () => {
      await hold(taken.id, dayFromNow(5), dayFromNow(10));

      const { body } = await search(`checkIn=${dayFromNow(10)}&checkOut=${dayFromNow(13)}`);

      expect(body.data.map((p: { title: string }) => p.title).sort())
        .toEqual(["Free one", "Taken one"]);
    });

    it("still offers a listing whose stay starts on the requested check-out", async () => {
      await hold(taken.id, dayFromNow(13), dayFromNow(20));

      const { body } = await search(`checkIn=${dayFromNow(10)}&checkOut=${dayFromNow(13)}`);

      expect(body.data.map((p: { title: string }) => p.title).sort())
        .toEqual(["Free one", "Taken one"]);
    });

    // A cancelled booking holds nothing — the same list the overlap constraint
    // uses, so the browse filter and the constraint cannot disagree.
    it("offers a listing again once its booking is cancelled", async () => {
      await db.insert(bookings).values({
        propertyId: taken.id,
        guestId,
        checkIn: dayFromNow(10),
        checkOut: dayFromNow(15),
        guestCount: 2,
        totalAmountCents: 2_550_000,
        status: "cancelled",
        cancelledAt: new Date(),
      });

      const { body } = await search(`checkIn=${dayFromNow(11)}&checkOut=${dayFromNow(13)}`);

      expect(body.data).toHaveLength(2);
    });

    // Dates the host took off the market are not for sale either.
    it("hides a listing blacked out across the requested dates", async () => {
      await app.request("/blackouts", {
        method: "POST",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({
          propertyId: taken.id,
          startDate: dayFromNow(10),
          endDate: dayFromNow(15),
        }),
      });

      const { body } = await search(`checkIn=${dayFromNow(11)}&checkOut=${dayFromNow(13)}`);

      expect(body.data.map((p: { title: string }) => p.title)).toEqual(["Free one"]);
    });

    // Several overlapping bookings must exclude the listing once, not repeat
    // it — the reason this is NOT EXISTS rather than a join.
    it("excludes a listing once however many bookings overlap", async () => {
      await hold(taken.id, dayFromNow(10), dayFromNow(12));
      await hold(taken.id, dayFromNow(12), dayFromNow(14));
      await hold(taken.id, dayFromNow(14), dayFromNow(16));

      const { body } = await search(`checkIn=${dayFromNow(11)}&checkOut=${dayFromNow(15)}`);

      expect(body.data.map((p: { title: string }) => p.title)).toEqual(["Free one"]);
      expect(body.meta.total).toBe(1);
    });

    it("combines with the other filters", async () => {
      await makeProperty(admin.id, { title: "Nyali flat", town: "Nyali" });
      await hold(taken.id, dayFromNow(10), dayFromNow(15));

      const { body } = await search(
        `town=Diani&checkIn=${dayFromNow(11)}&checkOut=${dayFromNow(13)}`,
      );

      expect(body.data.map((p: { title: string }) => p.title)).toEqual(["Free one"]);
    });

    // Ignoring the lone date would show dates that are taken as available.
    it.each(["checkIn", "checkOut"])("422s %s without the other", async (param) => {
      const { status } = await search(`${param}=${dayFromNow(10)}`);
      expect(status).toBe(422);
    });

    it("422s a check-out on or before the check-in", async () => {
      const same = await search(`checkIn=${dayFromNow(10)}&checkOut=${dayFromNow(10)}`);
      const backwards = await search(`checkIn=${dayFromNow(13)}&checkOut=${dayFromNow(10)}`);

      expect(same.status).toBe(422);
      expect(backwards.status).toBe(422);
    });

    it("returns everything when no dates are given", async () => {
      await hold(taken.id, dayFromNow(10), dayFromNow(15));

      const { body } = await search("");

      expect(body.data).toHaveLength(2);
    });
  });
});
