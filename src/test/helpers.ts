import { eq } from "drizzle-orm";

import type { UserRole } from "@/lib/types";

import app from "@/app";
import db, { pool } from "@/db";
import { properties, user } from "@/db/schema";
import { sentOtps } from "@/lib/auth";
import { normalizeKenyanPhone } from "@/lib/phone";

/**
 * Wipes every table between tests. Discovered dynamically so a new table
 * doesn't silently start leaking state across tests.
 */
export async function resetDb() {
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);

  if (rows.length === 0)
    return;

  const tables = rows.map(r => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function postJson(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export interface TestUser {
  id: string;
  phoneNumber: string;
  /** Ready-to-spread request headers carrying the session cookie. */
  headers: { cookie: string };
}

/**
 * Signs a user in through the real phone+OTP flow rather than forging a
 * session row — that way the tests exercise the same code path production
 * does, and cookie signing can't silently drift out of sync.
 *
 * `role` is applied directly to the row afterwards because role is
 * deliberately not client-settable.
 */
export async function signIn(
  phoneNumber: string,
  role: UserRole = "guest",
): Promise<TestUser> {
  const normalized = normalizeKenyanPhone(phoneNumber);
  if (!normalized)
    throw new Error(`Test used an invalid Kenyan number: ${phoneNumber}`);

  const sent = await postJson("/api/auth/phone-number/send-otp", {
    phoneNumber: normalized,
  });
  if (!sent.ok)
    throw new Error(`send-otp failed: ${sent.status} ${await sent.text()}`);

  const code = sentOtps.get(normalized);
  if (!code)
    throw new Error(`No OTP captured for ${normalized}`);

  const verified = await postJson("/api/auth/phone-number/verify", {
    phoneNumber: normalized,
    code,
  });
  if (!verified.ok)
    throw new Error(`verify failed: ${verified.status} ${await verified.text()}`);

  const setCookie = verified.headers.get("set-cookie");
  if (!setCookie)
    throw new Error("verify returned no session cookie");

  // Keep only the name=value pairs; a request Cookie header carries no attributes.
  const cookie = setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");

  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.phoneNumber, normalized));

  if (!row)
    throw new Error(`User row missing after verify for ${normalized}`);

  if (role !== "guest")
    await db.update(user).set({ role }).where(eq(user.id, row.id));

  return { id: row.id, phoneNumber: normalized, headers: { cookie } };
}

let phoneCounter = 0;

/** Unique valid Kenyan mobile number, so tests never collide on the unique index. */
export function nextPhone() {
  phoneCounter += 1;
  return `+2547${String(10_000_000 + phoneCounter).slice(0, 8)}`;
}

type PropertyOverrides = Partial<typeof properties.$inferInsert>;

/** Creates an active, bookable property owned by `hostId`. */
export async function makeProperty(hostId: string, overrides: PropertyOverrides = {}) {
  const [row] = await db
    .insert(properties)
    .values({
      hostId,
      title: "Diani Beach Villa",
      description: "Three-bedroom villa a short walk from the beach.",
      propertyType: "villa",
      status: "active",
      county: "Kwale",
      town: "Diani",
      maxGuests: 6,
      bedrooms: 3,
      bathrooms: 2,
      beds: 4,
      // KES 8,500/night, in cents and divisible by 100 as the CHECK requires.
      pricePerNightCents: 850_000,
      cleaningFeeCents: 150_000,
      ...overrides,
    })
    .returning();

  return row;
}

/** `offset` days from today as a YYYY-MM-DD string, matching the `date` columns. */
export function dayFromNow(offset: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Signs up and signs in with email+password — the method that works while SMS
 * is deferred, and the one most guests will actually use today.
 */
export async function signUpWithEmail(
  email: string,
  password = "correct-horse-battery",
  name = "Test Guest",
): Promise<TestUser> {
  const res = await postJson("/api/auth/sign-up/email", { email, password, name });
  if (!res.ok)
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie)
    throw new Error("sign-up returned no session cookie");

  const cookie = setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");

  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row)
    throw new Error(`User row missing after sign-up for ${email}`);

  return { id: row.id, phoneNumber: "", headers: { cookie } };
}

let emailCounter = 0;

/** Unique address, so tests never collide on user.email's unique index. */
export function nextEmail() {
  emailCounter += 1;
  return `guest${emailCounter}@example.test`;
}
