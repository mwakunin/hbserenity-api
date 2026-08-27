# Rentals API

Short-term rental booking and management for Kenya. Single host, public
guests.

> **Status:** the booking core is complete and tested. M-Pesa payment is
> **not implemented yet** — the `payments` table and configuration are in
> place, but no code calls Safaricom. Bookings are created in
> `pending_payment` and stay there. See [CLAUDE.md](./CLAUDE.md) for the full
> list of what is and isn't built.

Built on [Hono](https://hono.dev/) with `@hono/zod-openapi`, Drizzle ORM
against Postgres, and Better Auth for phone+OTP sign-in. Interactive API docs
are served by [Scalar](https://scalar.com/).

## Setup

Requires Node 20+, pnpm, and Docker.

```sh
pnpm install
cp .env.example .env
```

Fill in `BETTER_AUTH_SECRET` (32+ chars):

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Start Postgres (dev + test) and Redis, then migrate and run:

```sh
./dev.sh
pnpm db:migrate
pnpm dev
```

The API is at http://localhost:9999 — API reference at
[`/reference`](http://localhost:9999/reference), OpenAPI spec at `/doc`.

## Commands

| Command                       | What it does                                             |
| ----------------------------- | -------------------------------------------------------- |
| `./dev.sh`                    | Start Postgres (:5434 dev, :5433 test) and Redis (:6380) |
| `pnpm dev`                    | Run the API in watch mode                                |
| `pnpm test`                   | Run the suite against the test database                  |
| `pnpm lint` / `pnpm lint:fix` | ESLint                                                   |
| `pnpm typecheck`              | `tsc --noEmit`                                           |
| `pnpm db:generate`            | Create a migration from `src/db/schema.ts`               |
| `pnpm db:migrate`             | Apply migrations                                         |
| `pnpm db:studio`              | Inspect the database                                     |

## Endpoints

| Path                                   | Auth   | Description                                 |
| -------------------------------------- | ------ | ------------------------------------------- |
| `GET /`                                | —      | Index                                       |
| `GET /health`                          | —      | Readiness probe; pings the database         |
| `GET /doc`                             | —      | OpenAPI specification                       |
| `GET /reference`                       | —      | Scalar API documentation                    |
| `POST /api/auth/phone-number/send-otp` | —      | Request a sign-in OTP                       |
| `POST /api/auth/phone-number/verify`   | —      | Verify the OTP, receive a session           |
| `GET /properties`                      | public | Browse active listings (filters, paginated) |
| `GET /properties/{id}`                 | public | One listing with images and amenities       |
| `POST /properties`                     | admin  | Create a listing                            |
| `PATCH /properties/{id}`               | admin  | Update a listing                            |
| `DELETE /properties/{id}`              | admin  | Delete (409 if it has bookings)             |
| `GET /properties/{id}/availability`    | public | Taken date ranges                           |
| `POST /bookings`                       | guest  | Book a property (409 if dates are taken)    |
| `GET /bookings`                        | guest  | Own bookings; admin sees all                |
| `GET /bookings/{id}`                   | guest  | One booking                                 |
| `POST /bookings/{id}/cancel`           | guest  | Cancel a `pending_payment` booking          |
| `POST /blackouts`                      | admin  | Block dates without faking a booking        |

## Design notes

**Double-booking is impossible, not merely checked.** `bookings` carries a
Postgres `EXCLUDE USING gist` constraint over
`daterange(check_in, check_out, '[)')`, scoped to the statuses that hold dates.
A service-layer availability check cannot be the defence — two concurrent
requests both pass it and both insert. The handler catches SQLSTATE `23P01`
and returns 409. This is covered by tests that fire five simultaneous requests
at the same dates and assert exactly one wins.

Ranges are half-open, so a guest checking out on the 15th frees the 15th for
the next arrival.

**Dates are `date`, not `timestamp`.** A stay is a calendar range plus a
property check-in time. As `timestamptz` the date shifts across timezones and
the nights count drifts.

**Money is integer cents with a `CHECK (x % 100 = 0)`.** M-Pesa only transacts
whole shillings, so the constraint makes an unpayable amount unstorable.

**Prices are snapshotted.** `bookings.totalAmountCents` is computed server-side
at creation and never recalculated — changing a property's rate must not
change what an existing guest owes. A client-sent total is ignored.

See [CLAUDE.md](./CLAUDE.md) for domain conventions, the Better Auth schema
regeneration procedure, and what is deliberately not built yet.

## Testing

`./dev.sh` must be running — the suite uses real Postgres. Tests drive the
actual phone+OTP sign-in flow rather than forging session rows.

```sh
pnpm test
```
