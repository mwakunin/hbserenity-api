import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { propertyImages } from "@/db/schema";
import { makeProperty, nextPhone, resetDb, signIn } from "@/test/helpers";

const ENDPOINT = "https://ik.imagekit.io/hbserenity-test";

function imageUrl(name: string) {
  return `${ENDPOINT}/${name}`;
}

describe("property images", () => {
  let admin: TestUser;
  let guest: TestUser;
  let propertyId: string;

  beforeEach(async () => {
    await resetDb();
    admin = await signIn(nextPhone(), "admin");
    guest = await signIn(nextPhone());
    const property = await makeProperty(admin.id);
    propertyId = property.id;
  });

  afterEach(() => vi.unstubAllGlobals());

  function attach(user: TestUser, body: object, id = propertyId) {
    return app.request(`/properties/${id}/images`, {
      method: "POST",
      headers: { "content-type": "application/json", ...user.headers },
      body: JSON.stringify(body),
    });
  }

  const uploadAuthFor = (user: TestUser, id = propertyId) =>
    app.request(`/properties/${id}/images/upload-auth`, {
      method: "POST",
      headers: user.headers,
    });

  describe("upload credentials", () => {
    // The signature authorises an upload into the account, so who can get one
    // matters as much as whether it is correct.
    it("401s anonymously and 403s a guest", async () => {
      const anon = await app.request(`/properties/${propertyId}/images/upload-auth`, {
        method: "POST",
      });
      expect(anon.status).toBe(401);
      expect((await uploadAuthFor(guest)).status).toBe(403);
    });

    it("404s a property that does not exist, before signing anything", async () => {
      const res = await uploadAuthFor(admin, "4651e634-a530-4484-9b09-9616a28f35e3");
      expect(res.status).toBe(404);
    });

    it("signs the token and expiry the way ImageKit verifies them", async () => {
      const res = await uploadAuthFor(admin);
      expect(res.status).toBe(200);

      const auth = await res.json();
      expect(auth.publicKey).toBe("public_test_key");
      expect(auth.urlEndpoint).toBe(ENDPOINT);

      // Recomputed here rather than trusting the handler's own arithmetic: a
      // signature ImageKit rejects makes every upload fail.
      const expected = createHmac("sha1", "private_test_key")
        .update(auth.token + auth.expire)
        .digest("hex");
      expect(auth.signature).toBe(expected);
    });

    it("expires the credentials within minutes, not hours", async () => {
      const { expire } = await (await uploadAuthFor(admin)).json();
      const secondsAway = expire - Math.floor(Date.now() / 1000);

      expect(secondsAway).toBeGreaterThan(0);
      expect(secondsAway).toBeLessThanOrEqual(15 * 60);
    });
  });

  describe("attaching", () => {
    it("attaches a photo and shows it on the listing", async () => {
      const res = await attach(admin, { url: imageUrl("a.jpg"), fileId: "file-a" });
      expect(res.status).toBe(201);

      const listing = await (await app.request(`/properties/${propertyId}`)).json();
      expect(listing.images).toHaveLength(1);
      expect(listing.images[0].url).toBe(imageUrl("a.jpg"));
    });

    it("403s a guest", async () => {
      const res = await attach(guest, { url: imageUrl("a.jpg"), fileId: "file-a" });
      expect(res.status).toBe(403);
    });

    // An unchecked url lets a listing be pointed at any host on the internet,
    // including one that serves something else later.
    it.each([
      "https://evil.test/pixel.gif",
      "https://ik.imagekit.io/someone-else/a.jpg",
      "http://ik.imagekit.io/hbserenity-test/a.jpg",
    ])("422s a url that is not on this account's endpoint: %s", async (url) => {
      const res = await attach(admin, { url, fileId: "file-x" });
      expect(res.status).toBe(422);
    });

    it("409s the same upload submitted twice", async () => {
      await attach(admin, { url: imageUrl("a.jpg"), fileId: "file-a" });
      const again = await attach(admin, { url: imageUrl("a.jpg"), fileId: "file-a" });

      expect(again.status).toBe(409);
    });

    it("404s a property that does not exist", async () => {
      const res = await attach(
        admin,
        { url: imageUrl("a.jpg"), fileId: "file-a" },
        "4651e634-a530-4484-9b09-9616a28f35e3",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("the cover photo", () => {
    it("moves the cover rather than ending up with two", async () => {
      await attach(admin, { url: imageUrl("a.jpg"), fileId: "file-a", isCover: true });
      await attach(admin, { url: imageUrl("b.jpg"), fileId: "file-b", isCover: true });

      const covers = await db.select()
        .from(propertyImages)
        .where(eq(propertyImages.isCover, true));

      expect(covers).toHaveLength(1);
      expect(covers[0].fileId).toBe("file-b");
    });

    it("moves the cover on patch", async () => {
      const first = await (await attach(admin, {
        url: imageUrl("a.jpg"),
        fileId: "file-a",
        isCover: true,
      })).json();
      const second = await (await attach(admin, {
        url: imageUrl("b.jpg"),
        fileId: "file-b",
      })).json();

      const res = await app.request(`/property-images/${second.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...admin.headers },
        body: JSON.stringify({ isCover: true }),
      });
      expect(res.status).toBe(200);

      const rows = await db.select().from(propertyImages);
      expect(rows.find(r => r.id === first.id)!.isCover).toBe(false);
      expect(rows.find(r => r.id === second.id)!.isCover).toBe(true);
    });

    // Two requests both read "no other cover" and both promote. The partial
    // unique index is what actually stops it; the clear-then-set is only for
    // the ordinary case.
    it("cannot end up with two covers under concurrency", async () => {
      const a = await (await attach(admin, { url: imageUrl("a.jpg"), fileId: "file-a" })).json();
      const b = await (await attach(admin, { url: imageUrl("b.jpg"), fileId: "file-b" })).json();

      const setCover = (id: string) => Promise.resolve(
        app.request(`/property-images/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...admin.headers },
          body: JSON.stringify({ isCover: true }),
        }),
      );

      const results = await Promise.all([setCover(a.id), setCover(b.id)]);

      // Whoever loses the race must lose cleanly — a 409, never a 500.
      for (const res of results)
        expect([200, 409]).toContain(res.status);

      const covers = await db.select()
        .from(propertyImages)
        .where(eq(propertyImages.isCover, true));

      expect(covers).toHaveLength(1);
    });
  });

  describe("removing", () => {
    async function attached() {
      const res = await attach(admin, { url: imageUrl("a.jpg"), fileId: "file-a" });
      return res.json();
    }

    const remove = (id: string) => app.request(`/property-images/${id}`, {
      method: "DELETE",
      headers: admin.headers,
    });

    it("deletes the file from ImageKit, then the record", async () => {
      const image = await attached();
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await remove(image.id);
      expect(res.status).toBe(204);

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("/files/file-a");
      expect(init?.method).toBe("DELETE");

      expect(await db.select().from(propertyImages)).toHaveLength(0);
    });

    // "Already gone" is the outcome we wanted, so a retry after a partial
    // failure must not be stuck forever.
    it("treats a 404 from ImageKit as already deleted", async () => {
      const image = await attached();
      vi.stubGlobal("fetch", vi.fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 })));

      expect((await remove(image.id)).status).toBe(204);
      expect(await db.select().from(propertyImages)).toHaveLength(0);
    });

    // The one that matters: dropping the row anyway would leave a file on the
    // CDN with no id recorded anywhere, billed and unfindable.
    it("keeps the record when ImageKit refuses, and says so", async () => {
      const image = await attached();
      vi.stubGlobal("fetch", vi.fn<typeof fetch>()
        .mockResolvedValue(new Response("nope", { status: 500 })));

      const res = await remove(image.id);
      expect(res.status).toBe(502);

      const rows = await db.select().from(propertyImages);
      expect(rows).toHaveLength(1);
      expect(rows[0].fileId).toBe("file-a");
    });

    it("keeps the record when ImageKit cannot be reached at all", async () => {
      const image = await attached();
      vi.stubGlobal("fetch", vi.fn<typeof fetch>()
        .mockRejectedValue(new Error("network down")));

      expect((await remove(image.id)).status).toBe(502);
      expect(await db.select().from(propertyImages)).toHaveLength(1);
    });

    it("404s an image that does not exist", async () => {
      const res = await remove("4651e634-a530-4484-9b09-9616a28f35e3");
      expect(res.status).toBe(404);
    });

    it("403s a guest", async () => {
      const image = await attached();
      const res = await app.request(`/property-images/${image.id}`, {
        method: "DELETE",
        headers: guest.headers,
      });
      expect(res.status).toBe(403);
    });
  });
});
