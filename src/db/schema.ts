import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { account, session, user, verification } from "./auth-schema";

// Re-exported so the rest of the app can `import { user } from "./schema"`
// alongside everything else, without caring that identity tables live in a
// separate Better-Auth-generated file.
export { account, session, user, verification };

// ---------------------------------------------------------------------------
// Shared column builders
// ---------------------------------------------------------------------------

// `.$onUpdate` is what actually makes updated_at move — `.defaultNow()` alone
// freezes it at insert time.
function updatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

/**
 * Money is stored as integer cents. M-Pesa only transacts whole shillings, so
 * every amount must be divisible by 100 — enforced in the database so a seed
 * script, migration or manual SQL can't sneak a bad row past the Zod layer.
 */
function wholeShillings(name: string, column: unknown) {
  return check(name, sql`${column} % 100 = 0 AND ${column} >= 0`);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

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
    // double precision carries ~15 significant digits — far more than the ~7
    // needed for centimetre accuracy, and unlike text it can be compared,
    // bounding-boxed and distance-sorted.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),

    maxGuests: integer("max_guests").notNull(),
    bedrooms: integer("bedrooms").notNull(),
    bathrooms: integer("bathrooms").notNull(),
    beds: integer("beds").notNull(),

    // Money stored as integer lowest-denomination units (cents) — never float.
    pricePerNightCents: integer("price_per_night_cents").notNull(),
    cleaningFeeCents: integer("cleaning_fee_cents").notNull().default(0),
    currency: text("currency").notNull().default("KES"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    index("properties_host_idx").on(table.hostId),
    index("properties_location_idx").on(table.county, table.town),
    index("properties_status_idx").on(table.status),
    wholeShillings("properties_price_per_night_whole", table.pricePerNightCents),
    wholeShillings("properties_cleaning_fee_whole", table.cleaningFeeCents),
    // `bedrooms` counts separate enclosed sleeping rooms, so 0 is legitimate
    // (a studio or bedsitter). `bathrooms` may be 0 where ablutions are
    // shared. `beds` is places to sleep and is never 0 — a listing with
    // maxGuests > 0 and nowhere to sleep is not bookable.
    check(
      "properties_capacity_positive",
      sql`${table.maxGuests} > 0 AND ${table.bedrooms} >= 0 AND ${table.bathrooms} >= 0 AND ${table.beds} >= 1`,
    ),
    // Keeps propertyType and bedrooms from contradicting each other: a studio
    // is by definition one open room, anything else has at least one bedroom.
    check(
      "properties_bedrooms_match_type",
      sql`(${table.propertyType} = 'studio' AND ${table.bedrooms} = 0)
        OR (${table.propertyType} <> 'studio' AND ${table.bedrooms} >= 1)`,
    ),
    check(
      "properties_latitude_range",
      sql`${table.latitude} IS NULL OR (${table.latitude} BETWEEN -90 AND 90)`,
    ),
    check(
      "properties_longitude_range",
      sql`${table.longitude} IS NULL OR (${table.longitude} BETWEEN -180 AND 180)`,
    ),
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
    createdAt: createdAt(),
  },
  table => [index("property_images_property_idx").on(table.propertyId)],
);

// ---------------------------------------------------------------------------
// Blackouts — dates the host takes off the market (maintenance, personal use,
// a booking taken off-platform). Without this, blocking dates means faking a
// booking. Availability must consider bookings AND blackouts.
// ---------------------------------------------------------------------------

export const propertyBlackouts = pgTable(
  "property_blackouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    // Half-open [startDate, endDate): endDate is the first available day again,
    // matching booking check-in/check-out semantics.
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  table => [
    index("property_blackouts_property_idx").on(table.propertyId),
    check("property_blackouts_dates_valid", sql`${table.endDate} > ${table.startDate}`),
  ],
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

    // Calendar dates, not instants. A stay is "27 Aug -> 30 Aug" plus a
    // property-level check-in time; as timestamptz the date shifts across
    // timezones and the nights count drifts. `date` also lets the overlap
    // exclusion constraint use daterange directly.
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),

    guestCount: integer("guest_count").notNull(),
    status: bookingStatusEnum("status").notNull().default("pending_payment"),

    // Snapshot the price at booking time — property pricing can change later,
    // this must not.
    totalAmountCents: integer("total_amount_cents").notNull(),
    currency: text("currency").notNull().default("KES"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    index("bookings_property_idx").on(table.propertyId),
    index("bookings_guest_idx").on(table.guestId),
    index("bookings_dates_idx").on(table.checkIn, table.checkOut),
    check("bookings_dates_valid", sql`${table.checkOut} > ${table.checkIn}`),
    check("bookings_guest_count_positive", sql`${table.guestCount} > 0`),
    wholeShillings("bookings_total_amount_whole", table.totalAmountCents),
    // NOTE: the real double-booking guard is an EXCLUDE USING gist constraint
    // that drizzle-kit cannot express. It lives in a hand-written migration —
    // see src/db/migrations/*_booking_overlap_constraints.sql. Do not rely on
    // the service-layer pre-check alone.
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

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    index("payments_booking_idx").on(table.bookingId),
    uniqueIndex("payments_checkout_request_idx").on(table.checkoutRequestId),
    wholeShillings("payments_amount_whole", table.amountCents),
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
    rating: integer("rating").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
  },
  table => [
    uniqueIndex("reviews_booking_idx").on(table.bookingId), // one review per booking
    index("reviews_property_idx").on(table.propertyId),
    check("reviews_rating_range", sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

// ALL relations for `user` live here, including the auth-side ones (sessions,
// accounts) that the Better Auth CLI would otherwise emit into auth-schema.ts.
// Drizzle allows only one `relations()` config per table, and db/index.ts
// spreads both modules into a single schema object — so a second definition
// over there would silently clobber this one rather than erroring.
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  properties: many(properties),
  bookings: many(bookings),
  reviews: many(reviews),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const propertiesRelations = relations(properties, ({ one, many }) => ({
  host: one(user, { fields: [properties.hostId], references: [user.id] }),
  images: many(propertyImages),
  amenities: many(propertyAmenities),
  blackouts: many(propertyBlackouts),
  bookings: many(bookings),
  reviews: many(reviews),
}));

export const propertyImagesRelations = relations(propertyImages, ({ one }) => ({
  property: one(properties, {
    fields: [propertyImages.propertyId],
    references: [properties.id],
  }),
}));

export const propertyBlackoutsRelations = relations(propertyBlackouts, ({ one }) => ({
  property: one(properties, {
    fields: [propertyBlackouts.propertyId],
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
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, {
    fields: [payments.bookingId],
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
