import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

// Re-exported so the rest of the app can `import { user } from "./schema"`
// alongside everything else, without caring that identity tables live in a
// separate Better-Auth-generated file.
export { user };

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// NOTE: role now lives on `user.role` (Better Auth additionalField, plain
// text) rather than as a Postgres enum column here — kept only if you need
// it for other enum columns that reference the same set of values.
export const propertyTypeEnum = pgEnum("property_type", [
  "apartment",
  "house",
  "villa",
  "cottage",
  "studio",
  "guesthouse",
]);

export const propertyStatusEnum = pgEnum("property_status", [
  "draft",
  "active",
  "inactive",
]);

export const bookingStatusEnum = pgEnum("booking_status", [
  "pending_payment",
  "confirmed",
  "cancelled",
  "completed",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "success",
  "failed",
  "timeout",
]);

export const payoutStatusEnum = pgEnum("payout_status", [
  "pending",
  "processing",
  "paid",
  "failed",
]);

// ---------------------------------------------------------------------------
// Identity (user, session, account, verification) lives in ./auth-schema.ts,
// owned by Better Auth. Domain tables below reference `user.id` directly —
// no separate app-level users table.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export const properties = pgTable(
  "properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // text, not uuid — matches Better Auth's default user.id type
    hostId: text("host_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    propertyType: propertyTypeEnum("property_type").notNull(),
    status: propertyStatusEnum("status").notNull().default("draft"),

    // Location — Kenya doesn't map cleanly onto postal codes, so county/town
    // carries the search/filtering weight; lat/lng powers map view.
    county: text("county").notNull(),
    town: text("town").notNull(),
    address: text("address"),
    latitude: text("latitude"), // stored as text to avoid float precision issues; parse on read
    longitude: text("longitude"),

    maxGuests: integer("max_guests").notNull(),
    bedrooms: integer("bedrooms").notNull(),
    bathrooms: integer("bathrooms").notNull(),
    beds: integer("beds").notNull(),

    // Money stored as integer lowest-denomination units (cents) — never float.
    pricePerNightCents: integer("price_per_night_cents").notNull(),
    cleaningFeeCents: integer("cleaning_fee_cents").notNull().default(0),
    currency: text("currency").notNull().default("KES"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("properties_host_idx").on(table.hostId),
    index("properties_location_idx").on(table.county, table.town),
    index("properties_status_idx").on(table.status),
  ],
);

export const propertyImages = pgTable(
  "property_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    order: integer("order").notNull().default(0),
    isCover: boolean("is_cover").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [index("property_images_property_idx").on(table.propertyId)],
);

// ---------------------------------------------------------------------------
// Amenities (many-to-many)
// ---------------------------------------------------------------------------

export const amenities = pgTable("amenities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  icon: text("icon"),
});

export const propertyAmenities = pgTable(
  "property_amenities",
  {
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    amenityId: uuid("amenity_id")
      .notNull()
      .references(() => amenities.id, { onDelete: "cascade" }),
  },
  table => [
    uniqueIndex("property_amenities_pk").on(table.propertyId, table.amenityId),
  ],
);

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    guestId: text("guest_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    checkIn: timestamp("check_in", { withTimezone: true, mode: "date" }).notNull(),
    checkOut: timestamp("check_out", { withTimezone: true, mode: "date" }).notNull(),
    guestCount: integer("guest_count").notNull(),
    status: bookingStatusEnum("status").notNull().default("pending_payment"),

    // Snapshot the price at booking time — property pricing can change later,
    // this must not.
    totalAmountCents: integer("total_amount_cents").notNull(),
    currency: text("currency").notNull().default("KES"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("bookings_property_idx").on(table.propertyId),
    index("bookings_guest_idx").on(table.guestId),
    // Overlap-prevention for confirmed bookings is enforced at the query/service
    // layer (or a Postgres exclusion constraint added later) — not expressible
    // as a simple unique index here.
    index("bookings_dates_idx").on(table.checkIn, table.checkOut),
  ],
);

// ---------------------------------------------------------------------------
// Payments — separate from bookings to keep a full retry/audit trail of
// every M-Pesa STK push attempt, not just the booking's final state.
// ---------------------------------------------------------------------------

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("mpesa"),
    phoneNumber: text("phone_number").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: paymentStatusEnum("status").notNull().default("pending"),

    // M-Pesa STK push correlation IDs — needed to match async callbacks
    // back to this payment attempt.
    checkoutRequestId: text("checkout_request_id"),
    merchantRequestId: text("merchant_request_id"),
    mpesaReceiptNumber: text("mpesa_receipt_number"),
    resultCode: integer("result_code"),
    resultDesc: text("result_desc"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    index("payments_booking_idx").on(table.bookingId),
    uniqueIndex("payments_checkout_request_idx").on(table.checkoutRequestId),
  ],
);

// ---------------------------------------------------------------------------
// Payouts — host-side money out. Deliberately separate from `payments`
// (guest money in) from day one.
// ---------------------------------------------------------------------------

export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: text("host_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    status: payoutStatusEnum("status").notNull().default("pending"),
    mpesaTransactionId: text("mpesa_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  table => [
    index("payouts_host_idx").on(table.hostId),
    index("payouts_booking_idx").on(table.bookingId),
  ],
);

// ---------------------------------------------------------------------------
// Reviews — tied to a completed booking, not just a property, so only
// guests who actually stayed can review.
// ---------------------------------------------------------------------------

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    guestId: text("guest_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(), // 1-5, enforce range in zod schema
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    uniqueIndex("reviews_booking_idx").on(table.bookingId), // one review per booking
    index("reviews_property_idx").on(table.propertyId),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

// Domain-side relations for `user` — kept here (not in auth-schema.ts) so
// that regenerating the Better-Auth-owned tables via the CLI never clobbers
// app-specific relation definitions.
export const userRelations = relations(user, ({ many }) => ({
  properties: many(properties),
  bookings: many(bookings),
  reviews: many(reviews),
  payouts: many(payouts),
}));

export const propertiesRelations = relations(properties, ({ one, many }) => ({
  host: one(user, { fields: [properties.hostId], references: [user.id] }),
  images: many(propertyImages),
  amenities: many(propertyAmenities),
  bookings: many(bookings),
  reviews: many(reviews),
}));

export const propertyImagesRelations = relations(propertyImages, ({ one }) => ({
  property: one(properties, {
    fields: [propertyImages.propertyId],
    references: [properties.id],
  }),
}));

export const amenitiesRelations = relations(amenities, ({ many }) => ({
  properties: many(propertyAmenities),
}));

export const propertyAmenitiesRelations = relations(propertyAmenities, ({ one }) => ({
  property: one(properties, {
    fields: [propertyAmenities.propertyId],
    references: [properties.id],
  }),
  amenity: one(amenities, {
    fields: [propertyAmenities.amenityId],
    references: [amenities.id],
  }),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  property: one(properties, {
    fields: [bookings.propertyId],
    references: [properties.id],
  }),
  guest: one(user, { fields: [bookings.guestId], references: [user.id] }),
  payments: many(payments),
  review: one(reviews),
  payout: one(payouts),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, {
    fields: [payments.bookingId],
    references: [bookings.id],
  }),
}));

export const payoutsRelations = relations(payouts, ({ one }) => ({
  host: one(user, { fields: [payouts.hostId], references: [user.id] }),
  booking: one(bookings, {
    fields: [payouts.bookingId],
    references: [bookings.id],
  }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  booking: one(bookings, {
    fields: [reviews.bookingId],
    references: [bookings.id],
  }),
  property: one(properties, {
    fields: [reviews.propertyId],
    references: [properties.id],
  }),
  guest: one(user, { fields: [reviews.guestId], references: [user.id] }),
}));
