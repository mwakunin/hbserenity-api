# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

A short-term rental management platform for Kenya (Airbnb-style). Hosts list
properties, guests book and pay via M-Pesa (STK push). Two apps in this repo:

- **API** — Hono + `@hono/zod-openapi`, Drizzle ORM, Neon (serverless Postgres)
- **Web** — Next.js frontend

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
pnpm test             # vitest — expects DATABASE_URL pointed at rentals_test (port 5433)
pnpm lint             # eslint
pnpm db:generate      # drizzle-kit generate — create migration from schema.ts
pnpm db:migrate       # drizzle-kit migrate — apply migrations
pnpm db:studio        # drizzle-kit studio — inspect DB
```

(Adjust the above to match whatever scripts actually end up in `package.json`
— fill these in once they're defined.)

docker-compose.yml / dev.sh live at the repo root and stand up local Postgres
(dev on :5432, test on :5433 with tmpfs — disposable) and Redis (:6379).

## Domain conventions — do not deviate without discussion

- **Money**: always stored and passed around as integers in the lowest
  denomination (cents), never floats. Fields are suffixed `*Cents`. Currency
  is a separate `currency` column, default `"KES"`.
- **Phone numbers**: E.164 format (`+2547XXXXXXXX`) everywhere — this is the
  join key for M-Pesa STK push, so normalize on input rather than at
  payment time.
- **Booking status lifecycle**: `pending_payment → confirmed → completed`,
  or `→ cancelled` from `pending_payment`. Don't add new statuses without
  updating every place that switches on `booking.status`.
- **Payments are append-only per attempt**: a booking can have multiple
  `payments` rows (retries). Never overwrite a payment row's status —
  insert a new attempt instead if the guest retries. `checkoutRequestId` is
  the idempotency key for matching M-Pesa callbacks back to an attempt.
- **Booking price snapshot**: `bookings.totalAmountCents` is fixed at
  creation time and must never be recalculated from the property's current
  price later.
- **Booking date overlaps**: not enforced by a DB constraint yet — must be
  checked inside a transaction at booking-creation time until a Postgres
  exclusion constraint (`EXCLUDE USING gist`, `btree_gist`) is added.

## Database

- `src/db/schema.ts` is the single source of truth for the data model.
  Generate migrations with `drizzle-kit generate` after any schema change —
  never hand-write migration SQL unless patching something drizzle-kit can't
  express (e.g. the exclusion constraint above).
- Local dev and test run against Docker Postgres (started via `./dev.sh`), not
  Neon — dev on `rentals_dev` (:5432), test on `rentals_test` (:5433, tmpfs,
  disposable). Neon is only used for staging/prod; confirm `DATABASE_URL`
  before running migrations if it's ever pointed at a Neon branch.
- **Identity model resolved**: Better Auth owns `user`, `session`, `account`,
  `verification` in `src/db/auth-schema.ts` (generated via
  `npx @better-auth/cli generate`, phoneNumber plugin enabled — phone+OTP is
  the primary login method, not email/password). There is no separate
  app-level `users` table. `user.role` (`"guest" | "host" | "admin"`) is a
  Better Auth `additionalField`.
- **`user.id` is `text`, not `uuid`** — every domain FK that points at a user
  (`properties.hostId`, `bookings.guestId`, `reviews.guestId`,
  `payouts.hostId`) must be `text` to match. This bit us once already —
  don't reintroduce `uuid` on a user-referencing column.
- Domain-side relations for `user` (e.g. `user.properties`, `user.bookings`)
  live in `src/db/schema.ts`, not `auth-schema.ts` — keeps them from being
  clobbered when the Better Auth CLI regenerates its tables.

## Environment variables

```
DATABASE_URL=                # local Docker Postgres (dev); Neon connection string in staging/prod
TEST_DATABASE_URL=           # local Docker Postgres (test, :5433)
REDIS_URL=                   # local Docker Redis in dev

BETTER_AUTH_SECRET=
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
  stay accurate.
- Run `pnpm lint` and `pnpm test` before considering a change done.
- Don't add new top-level dependencies without checking whether Hono/Drizzle
  already cover the need.
