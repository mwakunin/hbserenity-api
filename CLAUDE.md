# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

A short-term rental management platform for Kenya (Airbnb-style). **Single
host** — you own and manage the properties; guests browse publicly and must
verify a phone number to book, then pay by M-Pesa STK push. A booking is
created in `pending_payment` and becomes `confirmed` only once Safaricom
confirms the payment — see the callback rules below, which matter.

This repo currently contains **only the API** — Hono + `@hono/zod-openapi`,
Drizzle ORM, Postgres (local Docker for dev/test, Neon for staging/prod). It is
a single package, not a workspace. A Next.js frontend is planned but not
present; when it arrives, move the API to `apps/api` and add `apps/web`.

## Tech stack & key libraries

- **Runtime/API**: Hono, `@hono/node-server`, `@hono/zod-openapi`, `hono-pino` (logging)
- **DB**: Drizzle ORM + `drizzle-kit` against Postgres (local Docker for dev/test,
  Neon for staging/prod), `drizzle-zod` for request/response schema generation
  from table definitions
- **Cache / rate-limit store**: Redis (local Docker for dev/test)
- **Auth**: Better Auth
- **Rate limiting**: `rate-limiter-flexible` with its Redis store — chosen over
  in-memory limiters because it works correctly across multiple API instances
  sharing one Redis. Apply tighter limits on the M-Pesa STK-push endpoint
  specifically.
- **Email**: Resend, for transactional email (booking confirmations, payment
  receipts, host notifications)
- **Image CDN**: ImageKit, for property photo storage/delivery and on-the-fly
  resize/crop transforms
- **Validation**: Zod (v4) — all route input/output schemas derive from
  `drizzle-zod`, not hand-written, to keep DB and API contracts in sync
- **Docs**: `@scalar/hono-api-reference` for OpenAPI docs UI
- **Lint/format**: `@antfu/eslint-config`, `eslint-plugin-format`
- **Tests**: Vitest
- **Env**: `dotenv` / `dotenv-expand`

## Commands

```bash
./dev.sh              # start local Postgres (dev + test) and Redis via Docker Compose
pnpm dev              # run API in watch mode (tsx)
pnpm build            # typecheck + compile (tsc, tsc-alias for path aliases)
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest — resolves the DB to TEST_DATABASE_URL (:5433) automatically
pnpm lint             # eslint
pnpm lint:fix         # eslint --fix
pnpm db:generate      # drizzle-kit generate — create migration from schema.ts
pnpm db:migrate       # drizzle-kit migrate — apply migrations (dev DB)
pnpm db:migrate:test  # apply migrations to the test DB (:5433)
pnpm db:studio        # drizzle-kit studio — inspect DB
```

`pnpm test` does not need `NODE_ENV` set by hand — `env.ts` resolves
`DATABASE_URL` to `TEST_DATABASE_URL` whenever `NODE_ENV=test`, and refuses to
start if `TEST_DATABASE_URL` is missing. That guard exists so a stray test run
can never truncate the development database.

docker-compose.yml / dev.sh live at the repo root and stand up local Postgres
(dev on :5434, test on :5433 with tmpfs — disposable) and Redis (:6380).
Non-default dev ports are deliberate: another project on this machine binds
5432 and 6379, so both can run at once.

## Domain conventions — do not deviate without discussion

- **Money**: always stored and passed around as integers in the lowest
  denomination (cents), never floats. Fields are suffixed `*Cents`. Currency
  is a separate `currency` column, default `"KES"`.
  M-Pesa only transacts **whole shillings**, so every money column carries a
  DB `CHECK (x % 100 = 0 AND x >= 0)`. The Zod layer mirrors it so a bad
  amount is a readable 422 rather than a constraint-violation 500. Divide by
  100 at the M-Pesa boundary; it is always exact.
- **Phone numbers**: E.164 format (`+2547XXXXXXXX`) everywhere — this is the
  join key for M-Pesa STK push, so normalize on input rather than at
  payment time.

- **Capacity fields mean specific things** — don't conflate them:
  - `bedrooms` = separate **enclosed sleeping rooms**. Legitimately `0`.
  - `beds` = **places to sleep**. Never `0` (`CHECK beds >= 1`); a listing
    that sleeps nobody isn't bookable.
  - `bathrooms` = may be `0` where ablutions are shared.
  - `maxGuests` = the booking cap, enforced against `bookings.guestCount`.

  A **studio or bedsitter** is `propertyType: "studio"` with `bedrooms: 0`.
  There is deliberately no separate `bedsitter` type — the two differ by
  fit-out and price tier, not structure, and "studio" is the term guests
  search on. `properties_bedrooms_match_type` keeps the two columns from
  contradicting each other: a `studio` must have `bedrooms = 0`, and every
  other type must have `bedrooms >= 1`.

  A PATCH can't be checked across fields by Zod — the body carries only the
  changed keys, not the resulting row — so the DB CHECK is the backstop and
  `properties.handlers.ts` maps SQLSTATE `23514` onto the same 422 shape Zod
  produces. Add a `CHECK_MESSAGES` entry whenever you add a CHECK
  constraint, or the caller gets a generic message.

- **Booking status lifecycle**: `pending_payment → confirmed → completed`,
  or `→ cancelled` from `pending_payment`. Don't add new statuses without
  updating every place that switches on `booking.status` — including the
  `WHERE` clause of the `bookings_no_overlap` constraint, which lists the
  statuses that hold dates (`pending_payment`, `confirmed`).

- **Booking dates are `date`, not `timestamp`**. A stay is a calendar range
  plus a property-level check-in time; as `timestamptz` the date shifts
  across timezones and the nights count drifts. Ranges are half-open
  `[checkIn, checkOut)` — the checkout day is immediately bookable by the
  next guest, so back-to-back stays are legal and must stay legal.
- **Payments are append-only per attempt**: a booking can have multiple
  `payments` rows (retries). A **retry inserts a new row** — never reuse or
  overwrite a previous attempt, so a failure is still on the record after a
  later success. A row's own status does move once, `pending` → terminal,
  when its outcome arrives. `checkoutRequestId` is the idempotency key
  matching a callback back to an attempt.

- **The M-Pesa callback is unauthenticated — treat it as a hint, never as
  proof.** Safaricom does not sign callbacks, so the endpoint:
  1. optionally checks the source IP (`MPESA_CALLBACK_ALLOWED_IPS`);
  2. ignores unknown `checkoutRequestId`s and already-settled payments, so a
     replay cannot re-confirm anything;
  3. rejects any callback whose amount differs from the booking total;
  4. **queries Safaricom directly** (`queryStkStatus`) and confirms only if
     Safaricom agrees. If that query fails, the payment is left `pending`
     rather than confirmed — fail closed.

  It also **never returns `checkoutRequestId` (or `merchantRequestId`) to the
  client, from any endpoint**. Those ids are all the callback needs to
  identify a payment, so handing one over would let a guest start a real push,
  cancel it, and forge a result for it. The payment-history endpoint selects
  an explicit column list rather than `select()` for exactly this reason —
  a bare select would start leaking any correlation id added to the table
  later. Verify both here and in `publicPaymentSchema` when adding columns.

  Because verification covers failures too, a forged _failure_ cannot settle
  an attempt either. That matters: settling it would make the genuine success
  callback look already-handled, stranding a booking the guest has paid for.

  **At most one pending attempt per booking**, enforced by the partial unique
  index `payments_one_pending_per_booking`. A check-then-insert cannot hold —
  two concurrent requests both read "none pending" and both push, so the guest
  gets two prompts and can be charged twice. Stale pending rows are moved to
  `timeout` before a new insert so an abandoned prompt can't block retries.

  Terminal writes are compare-and-swap, so two callbacks racing for one
  attempt cannot have the loser overwrite the winner — a failure clobbering a
  verified success would leave the payment recorded failed while its booking
  stayed confirmed.

- **`timeout` is not a settled status.** `success` and `failed` are
  Safaricom's verdicts and must never be reopened. `timeout` is only _our_
  guess that we stopped waiting, so a late callback saying the guest paid
  still settles it — otherwise the money is taken and the booking never
  confirms. `SETTLED_STATUSES` vs `RESOLVABLE_STATUSES` encode this; keep
  them apart.

- **Every Daraja call is bounded** by `DARAJA_TIMEOUT_MS`. `fetch` has no
  default timeout, and this is load-bearing rather than hygiene: a push still
  in flight has not recorded its `checkoutRequestId`, and a pending attempt
  with no checkout id is treated as "no prompt was delivered". The timeout must
  stay well under `PUSH_COOLDOWN_MS` so an in-flight push has aborted before
  its attempt can be released — otherwise it could succeed afterwards and put a
  second prompt on the guest's handset.

- **`pushDispatchedAt` is set before the push goes out**, and it is what makes
  a pending attempt with no `checkoutRequestId` unambiguous:
  - marker absent -> no push was ever dispatched, no prompt exists, safe to
    release;
  - marker present -> Safaricom may already have delivered a prompt we cannot
    identify, so the attempt is **never** released automatically. It holds the
    uniqueness guard until reconciliation or a human resolves it. Blocking
    that booking's retries is the lesser evil against charging the guest twice.

  For the same reason, a failed push only settles the attempt when Safaricom
  _answered and refused_ (`MpesaError.status` present). A timeout or network
  error is not proof that no prompt was delivered, so the attempt stays
  pending. And a push that succeeded but whose id could not be stored must
  never be marked failed — that would free a retry to add a second live prompt.

- **One rule decides whether an attempt may stop holding its booking**, and it
  lives in `verdictFor()` in `lib/mpesa.ts`. `paid` / `dead` / `indeterminate`
  — and only `dead` (or `paid`) may release. This was previously answered
  separately in the push-error path, the callback path and the stale-attempt
  path, which is how 1001 ("transaction in process") ended up terminal in one
  and still-live in another. **Do not re-derive this decision locally**; every
  new branch that settles an attempt must route through it.

  The same rule applies to a failed push: `MpesaError.definitive` is true only
  when Safaricom *answered and refused* (HTTP < 500). A 5xx, a timeout or a
  network error is not proof that no prompt exists.

  And because a *succeeded* attempt no longer holds the pending-only unique
  index, the booking status is re-read **under a row lock** immediately before
  inserting a new attempt. The check at the top of `initiate` is stale by then:
  `releaseStaleAttempt` makes network calls, and a callback can confirm the
  booking inside that window.

- **Never release a stale attempt on a timer alone.** The STK request has no
  guaranteed lifetime, so assuming a prompt died after N seconds can leave
  two live prompts and charge the guest twice. `releaseStaleAttempt()` asks
  Safaricom and releases only on a result code in `DEAD_RESULT_CODES` — an
  allowlist, because "not a code I recognise" (including 1001, transaction in
  process) and any query error both mean _possibly still live_, and it fails
  closed. If the stale attempt turns out to have succeeded, it is settled and
  the booking confirmed rather than the guest being charged again.

  The endpoint always answers `200 {ResultCode: 0, ResultDesc: "Accepted"}`.
  Any other status makes Safaricom retry indefinitely — which is why the route
  carries its own validation hook in `payments.index.ts`. The schema tolerates
  junk inside the envelope, but a body that isn't an object at all (a bare
  array, a scalar, `null`) fails validation, and the default hook would answer
  422 and start an endless retry loop.

- **Booking price snapshot**: `bookings.totalAmountCents` is fixed at
  creation time and must never be recalculated from the property's current
  price later.
- **Booking date overlaps are enforced by the database.** `bookings` carries
  an `EXCLUDE USING gist (property_id WITH =, daterange(check_in, check_out,
'[)') WITH &&) WHERE (status IN ('pending_payment','confirmed'))`
  constraint, and `property_blackouts` carries the equivalent. They live in
  the hand-written migration `0001_booking_overlap_constraints.sql` because
  drizzle-kit cannot express EXCLUDE — **preserve that file** across any
  schema regeneration.

  A service-layer availability check is NOT the defence: two concurrent
  requests both pass it and both insert. The handler catches SQLSTATE
  `23P01` and maps it to 409. Note drizzle wraps driver errors in
  `DrizzleQueryError` and hangs the pg error off `.cause`, so the SQLSTATE
  is never on the top-level error object — walk the cause chain.

  **booking-vs-blackout** spans two tables, where no EXCLUDE constraint can
  reach. Both `create` (booking) and `createBlackout` therefore take a
  `SELECT ... FOR UPDATE` row lock on the property before checking the other
  table, which serializes bookings and blackouts for that one property. The
  lock is what makes those checks trustworthy: without it, a booking and an
  overlapping blackout each pass their own check concurrently and both
  commit, leaving a sold stay marked host-blocked. Keep the check **and** the
  lock on both sides — one side alone is not enough.

  Cost: concurrent bookings for the same property queue behind each other.
  Different properties are unaffected. Fine for a single-host business, and
  worth it for the correctness.

- **Read-then-write races: map the constraint, don't just pre-check.** A
  count-then-delete or check-then-insert pair is two statements, so the row
  can change in between. Pre-check for a good error message, then catch the
  constraint violation for the case the pre-check missed — `properties.remove`
  does this with `23503` (a booking arriving mid-delete still yields 409, not
  500). `lib/db-errors.ts` holds the SQLSTATE helpers; they are tested against
  errors drizzle actually throws, since a change in how drizzle wraps errors
  would silently turn every mapped 409/422 back into a 500.

- **Never trust a client-sent price.** `bookings.totalAmountCents` is always
  computed by `calculateBookingTotal()` in `src/lib/pricing.ts`, the single
  source of truth for what a stay costs.

## Database

- `src/db/schema.ts` is the single source of truth for the data model.
  Generate migrations with `drizzle-kit generate` after any schema change —
  never hand-write migration SQL unless patching something drizzle-kit can't
  express (e.g. the exclusion constraint above).
- Local dev and test run against Docker Postgres (started via `./dev.sh`), not
  Neon — dev on `rentals_dev` (:5434), test on `rentals_test` (:5433, tmpfs,
  disposable). Neon is only used for staging/prod; confirm `DATABASE_URL`
  before running migrations if it's ever pointed at a Neon branch.
- **Identity model resolved**: Better Auth owns `user`, `session`, `account`,
  `verification` in `src/db/auth-schema.ts` (generated via
  `npx @better-auth/cli@latest generate --config src/lib/auth.ts --output
src/db/auth-schema.ts --yes`, phoneNumber plugin enabled — phone+OTP is
  the primary login method, not email/password). There is no separate
  app-level `users` table. `user.role` (`"guest" | "host" | "admin"`) is a
  Better Auth `additionalField`.
- **Two deviations from raw CLI output must be reapplied after regenerating**
  (both documented in the file's own header):
  1. `user.role` gets `.notNull()` — the CLI emits it nullable, which would
     force a null-check at every authorization site.
  2. Delete the `userRelations` / `sessionRelations` / `accountRelations`
     block the CLI appends. Drizzle permits only one `relations()` per table
     and `schema.ts` re-exports these tables into one schema object, so a
     second definition **silently clobbers** the domain one rather than
     erroring.
- `user.email` is `NOT NULL UNIQUE` in Better Auth, so phone-first signup
  fills it with a `<phone>@phone.rentals.local` placeholder via
  `signUpOnVerification.getTempEmail`.
- **`user.id` is `text`, not `uuid`** — every domain FK that points at a user
  (`properties.hostId`, `bookings.guestId`, `reviews.guestId`) must be
  `text` to match. This bit us once already — don't reintroduce `uuid` on a
  user-referencing column.
- All relations for `user` — including the auth-side `sessions` and
  `accounts` — live in `src/db/schema.ts`, not `auth-schema.ts`, per the
  clobbering hazard above.
- `src/db/schema.ts` re-exports the Better-Auth-owned tables, so
  `drizzle.config.ts` and `db/index.ts` reference only `schema.ts`. Listing
  both files would register every auth table twice.

## Environment variables

All are validated by `src/env.ts` at startup; the process exits if a required
one is missing. The M-Pesa / Resend / ImageKit values are **optional in dev and
test, required when `NODE_ENV=production`** — so the API boots locally without
credentials for features that aren't built yet.

```dotenv
DATABASE_URL=                # local Docker Postgres (dev); Neon connection string in staging/prod
TEST_DATABASE_URL=           # local Docker Postgres (test, :5433); required when NODE_ENV=test
REDIS_URL=                   # local Docker Redis in dev

BETTER_AUTH_SECRET=          # min 32 chars; node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
BETTER_AUTH_URL=

MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=
MPESA_PASSKEY=
MPESA_CALLBACK_URL=          # must be a publicly reachable HTTPS URL

RESEND_API_KEY=

IMAGEKIT_PUBLIC_KEY=
IMAGEKIT_PRIVATE_KEY=
IMAGEKIT_URL_ENDPOINT=
```

See `.env.example` at the repo root for the full template.

## Working conventions

- New API routes: define the Zod request/response schema first (derived
  from `drizzle-zod` where the shape maps to a table), then the
  `zod-openapi` route, then the handler — in that order, so the OpenAPI docs
  stay accurate. Copy the four-file shape of `src/routes/properties/`
  (`.schemas` / `.routes` / `.handlers` / `.index`, plus `.test`).
- Check `stoker/openapi/schemas` before hand-rolling a helper — it already
  ships `IdParamsSchema`, `IdUUIDParamsSchema`, `SlugParamsSchema`,
  `createErrorSchema` and `createMessageObjectSchema`.
- `toZodV4SchemaTyped` (in `src/lib/zod-utils.ts`) bridges drizzle-zod's
  zod-v4 output into `@hono/zod-openapi`, but it casts away `.shape`. If a
  schema needs `.extend()`, compose it **before** wrapping.
- Hono's route `middleware` field rejects a readonly tuple, so a shared
  guard must be a function returning a fresh array, not an `as const` array.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before considering a
  change done.
- Don't add new top-level dependencies without checking whether Hono/Drizzle
  already cover the need.

## Testing

`./dev.sh` must be running — the suite talks to real Postgres, not a mock.

- `globalSetup` migrates the disposable test DB (:5433, tmpfs) once.
- `fileParallelism` is **off**: every file shares one database.
- `resetDb()` in `beforeEach` truncates. It discovers tables from
  `pg_tables`, so a new table can't silently start leaking state.
- `signIn(phone, role)` drives the **real** phone+OTP flow rather than
  forging a session row, so cookie signing can't drift from production. The
  OTP is captured via the `sentOtps` map, which is populated only when
  `NODE_ENV=test`.
- Use `nextPhone()` for a unique valid Kenyan number; a hard-coded one will
  collide on the unique index.
- UUIDs in tests must be **RFC-valid v4** — `1111...1111` fails zod's
  `.uuid()` on the version/variant nibbles and yields a confusing 422.

The tests that matter most are the overlap ones in
`src/routes/bookings/bookings.test.ts`: concurrent races resolving to
exactly one winner, and back-to-back stays still succeeding. They are the
difference between "we check for overlaps" and "overlaps are impossible."
Don't weaken them.

## Not built yet

Deliberately deferred — don't assume these exist:

- **Payment reconciliation.** If Safaricom is unreachable when a callback
  arrives, the payment is deliberately left `pending` rather than confirmed.
  Nothing sweeps those up yet — a job that re-runs `queryStkStatus` over
  stale pending payments is the missing piece, and until it exists such a
  booking needs settling by hand.
- **Refunds.** A payment can succeed against a booking the guest cancelled
  while the push was in flight. That is recorded truthfully (payment
  `success`, booking `cancelled`) and left for a human — there is no reversal
  API call.
- **Redis rate limiting** (`rate-limiter-flexible`) — Redis runs in compose
  but nothing uses it yet. Tightest limits belong on the STK-push endpoint.
- **Resend email** and **ImageKit uploads** — env vars only.
- **`payouts`** — dropped from the schema. With a single host, guest money
  lands directly in your paybill; there is no platform→host payout leg. It
  comes back only when a second host is onboarded.
- **Seasonal / weekend pricing** — one flat `pricePerNightCents` today. Diani
  high season and Nairobi weekday-business rates differ sharply, so a
  `property_rate_overrides` table is likely the next schema change.
- **Partial deposits** (50%-now-balance-later is common locally) — a payment
  is currently all-or-nothing against `bookings.totalAmountCents`,
  **cancellation metadata** (no `cancelledAt`/reason/refund trail), and a
  **booking idempotency key** so a double-tapped "Book now" can't create two
  bookings.
- **Reviews** — table and relations exist; no routes.
