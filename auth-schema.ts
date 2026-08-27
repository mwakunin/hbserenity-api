import {
  boolean,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// NOTE: This file's exact shape should come from running
//   npx @better-auth/cli generate
// against your actual Better Auth config (with the phoneNumber plugin
// enabled and `role` set up as an additionalField). What's below is the
// expected shape as of writing — treat it as a starting point, not gospel,
// and let the CLI output be the source of truth once you run it.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),

  // Added by the phoneNumber plugin — this is the primary identifier for
  // login (OTP-based), not email.
  phoneNumber: text("phone_number").unique(),
  phoneNumberVerified: boolean("phone_number_verified").notNull().default(false),

  // Custom field via `additionalFields` in the Better Auth user config.
  // Mirrors the app's userRoleEnum ("guest" | "host" | "admin") — kept as
  // plain text here since Better Auth's additionalFields typically map to
  // string/boolean/number, not Postgres enums; validate the value with Zod
  // at the auth-config level instead.
  role: text("role").notNull().default("guest"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  password: text("password"), // unused if phone OTP is the only auth method
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(), // phone number for OTP flow
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
