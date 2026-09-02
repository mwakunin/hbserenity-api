import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db from "@/db";
import { amenities, properties, propertyAmenities } from "@/db/schema";
import { backendPid, makeProperty, nextPhone, resetDb, signIn, waitForBlockedBackend } from "@/test/helpers";

/**
 * `resetDb()` truncates, which takes the seeded catalogue with it — so every
 * test creates the entries it needs rather than assuming migration 0015 left
 * any behind.
 */
async function makeAmenities(...names: string[]) {
  return db.insert(amenities)
    .values(names.map(name => ({ name })))
    .returning();
}

const UNKNOWN_ID = "4651e634-a530-4484-9b09-9616a28f35e3";

describe("amenities routes", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("catalogue", () => {
    it("lists the catalogue to anyone, sorted by name", async () => {
      await makeAmenities("Wi-Fi", "Air conditioning", "Swimming pool");

      const res = await app.request("/amenities");
      const { data } = await res.json();

      expect(res.status).toBe(200);
      expect(data.map((a: { name: string }) => a.name))
        .toEqual(["Air conditioning", "Swimming pool", "Wi-Fi"]);
    });

    it("lets an admin add one", async () => {
      const admin = await signIn(nextPhone(), "admin");

      const res = await app.request("/amenities", {
        method: "post",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Sea view", icon: "eye" }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ name: "Sea view", icon: "eye" });
    });

    // The catalogue is a shared vocabulary: two entries spelled the same are
    // two different pickable things that mean one.
    it("409s a duplicate name rather than adding a second entry", async () => {
      const admin = await signIn(nextPhone(), "admin");
      await makeAmenities("Wi-Fi");

      const res = await app.request("/amenities", {
        method: "post",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Wi-Fi" }),
      });

      expect(res.status).toBe(409);
    });

    // A trailing space slips past a UNIQUE constraint, so trimming is what
    // actually stops the duplicate rather than tidiness.
    it("trims a name before the uniqueness check sees it", async () => {
      const admin = await signIn(nextPhone(), "admin");
      await makeAmenities("Wi-Fi");

      const res = await app.request("/amenities", {
        method: "post",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "  Wi-Fi  " }),
      });

      expect(res.status).toBe(409);
    });

    it.each([
      ["a guest", "guest"],
      ["a host", "host"],
    ])("forbids %s from adding one", async (_label, role) => {
      const caller = await signIn(nextPhone(), role as "guest" | "host");

      const res = await app.request("/amenities", {
        method: "post",
        headers: { ...caller.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Sea view" }),
      });

      expect(res.status).toBe(403);
    });

    it("401s an anonymous add", async () => {
      const res = await app.request("/amenities", {
        method: "post",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Sea view" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("setting them on a listing", () => {
    async function setFor(propertyId: string, headers: HeadersInit, amenityIds: string[]) {
      return app.request(`/properties/${propertyId}/amenities`, {
        method: "put",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ amenityIds }),
      });
    }

    it("attaches them and shows them on the listing", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi, pool] = await makeAmenities("Wi-Fi", "Swimming pool");

      const res = await setFor(property.id, admin.headers, [wifi.id, pool.id]);
      const { data } = await res.json();

      expect(res.status).toBe(200);
      expect(data.map((a: { name: string }) => a.name)).toEqual(["Swimming pool", "Wi-Fi"]);

      // The point of the endpoint: the detail response stops being empty.
      const detail = await (await app.request(`/properties/${property.id}`)).json();
      expect(detail.amenities.map((a: { name: string }) => a.name).sort())
        .toEqual(["Swimming pool", "Wi-Fi"]);
    });

    // PUT replaces, so unticking a box is expressed by leaving it out. If it
    // merged instead, nothing could ever be removed.
    it("replaces the set rather than adding to it", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi, pool, parking] = await makeAmenities("Wi-Fi", "Swimming pool", "Parking");

      await setFor(property.id, admin.headers, [wifi.id, pool.id]);
      const res = await setFor(property.id, admin.headers, [parking.id]);
      const { data } = await res.json();

      expect(data.map((a: { name: string }) => a.name)).toEqual(["Parking"]);
    });

    it("clears them all when sent an empty list", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi] = await makeAmenities("Wi-Fi");

      await setFor(property.id, admin.headers, [wifi.id]);
      const res = await setFor(property.id, admin.headers, []);

      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });

    // Re-submitting an unchanged form must not be an error, which is the
    // reason to replace a set rather than post one attachment at a time.
    it("is idempotent when the same set is sent twice", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi, pool] = await makeAmenities("Wi-Fi", "Swimming pool");

      await setFor(property.id, admin.headers, [wifi.id, pool.id]);
      const res = await setFor(property.id, admin.headers, [wifi.id, pool.id]);

      expect(res.status).toBe(200);
      expect((await res.json()).data).toHaveLength(2);

      const rows = await db.select()
        .from(propertyAmenities)
        .where(eq(propertyAmenities.propertyId, property.id));
      expect(rows).toHaveLength(2);
    });

    // A checkbox list can submit the same id twice; `property_amenities_pk`
    // would turn that into a constraint violation.
    it("ignores a repeated id instead of failing on the unique index", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi] = await makeAmenities("Wi-Fi");

      const res = await setFor(property.id, admin.headers, [wifi.id, wifi.id, wifi.id]);

      expect(res.status).toBe(200);
      expect((await res.json()).data).toHaveLength(1);
    });

    // Named, not just refused: a form posting several ids gives no clue which
    // one was wrong otherwise.
    it("422s an id that is not in the catalogue, and changes nothing", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi] = await makeAmenities("Wi-Fi");

      await setFor(property.id, admin.headers, [wifi.id]);
      const res = await setFor(property.id, admin.headers, [wifi.id, UNKNOWN_ID]);

      expect(res.status).toBe(422);
      expect((await res.json()).error.issues[0].message).toContain(UNKNOWN_ID);

      // The whole request failed, so the previous set is untouched.
      const rows = await db.select()
        .from(propertyAmenities)
        .where(eq(propertyAmenities.propertyId, property.id));
      expect(rows).toHaveLength(1);
    });

    /*
     * Replacing a set is delete-then-insert, two statements. Under READ
     * COMMITTED two concurrent replacements each delete only the rows their
     * own statement can see and then both insert, leaving the union of the
     * two sets — which is neither of the things anybody asked for. The
     * property row lock is what settles it.
     *
     * Sending an EMPTY set is what isolates that lock. A replacement that
     * inserts would block on a held FOR UPDATE regardless, because the
     * foreign key to `properties` takes a KEY SHARE lock that conflicts with
     * it — so it would pass with the handler's own lock removed. An empty set
     * only deletes, touches no foreign key, and therefore blocks only if the
     * handler took the lock itself.
     */
    it("waits for a transaction holding the property lock", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);

      let finished = false;
      let finishedWhileLocked: boolean | null = null;
      let writer: Promise<Response> | undefined;

      await db.transaction(async (tx) => {
        // Taken exactly as booking creation and blackouts take it.
        await tx.select({ id: properties.id })
          .from(properties)
          .where(eq(properties.id, property.id))
          .for("update");

        const holder = await backendPid(tx);

        writer = setFor(property.id, admin.headers, []).then((r) => {
          finished = true;
          return r;
        });

        expect(await waitForBlockedBackend(holder)).toBe(true);
        finishedWhileLocked = finished;
      });

      const res = await writer!;

      expect(finishedWhileLocked).toBe(false);
      expect(res.status).toBe(200);
    });

    it("404s an unknown property", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const [wifi] = await makeAmenities("Wi-Fi");

      const res = await setFor(UNKNOWN_ID, admin.headers, [wifi.id]);

      expect(res.status).toBe(404);
    });

    it.each([
      ["a guest", "guest"],
      ["a host", "host"],
    ])("forbids %s from setting them", async (_label, role) => {
      const admin = await signIn(nextPhone(), "admin");
      const caller = await signIn(nextPhone(), role as "guest" | "host");
      const property = await makeProperty(admin.id);
      const [wifi] = await makeAmenities("Wi-Fi");

      const res = await setFor(property.id, caller.headers, [wifi.id]);

      expect(res.status).toBe(403);
    });

    // Removing a listing should take its attachments with it rather than
    // leaving rows pointing at nothing.
    it("drops the attachments when the property is deleted", async () => {
      const admin = await signIn(nextPhone(), "admin");
      const property = await makeProperty(admin.id);
      const [wifi] = await makeAmenities("Wi-Fi");

      await setFor(property.id, admin.headers, [wifi.id]);
      await app.request(`/properties/${property.id}`, {
        method: "delete",
        headers: admin.headers,
      });

      const rows = await db.select()
        .from(propertyAmenities)
        .where(eq(propertyAmenities.propertyId, property.id));
      expect(rows).toEqual([]);
    });
  });
});
