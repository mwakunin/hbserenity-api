# Rentals API

Short-term rental booking and management for Kenya. Single host, public
guests.

> **Status:** booking and M-Pesa payment are complete and tested against a
> mocked Safaricom. Add your Daraja credentials to `.env` to run it for real.
> Not yet built: refunds, booking-confirmation email, and photo uploads —
> see [CLAUDE.md](./CLAUDE.md) for the full list.

Built on [Hono](https://hono.dev/) with `@hono/zod-openapi`, Drizzle ORM
against Postgres, and Better Auth. Sign-in is email+password, with Google
available when credentials are configured; phone+OTP is implemented but
dormant until an SMS provider is wired. Verification email is sent via Resend
when configured. Interactive API docs
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

| Path                                   | Auth   | Description                                                                    |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `GET /`                                | —      | Index                                                                          |
| `GET /health`                          | —      | Readiness probe; pings the database                                            |
| `GET /doc`                             | —      | OpenAPI specification                                                          |
| `GET /reference`                       | —      | Scalar API documentation                                                       |
| `POST /api/auth/phone-number/send-otp` | —      | Request a sign-in OTP                                                          |
| `POST /api/auth/phone-number/verify`   | —      | Verify the OTP, receive a session                                              |
| `GET /properties`                      | public | Browse active listings (filters, paginated)                                    |
| `GET /properties/{id}`                 | public | One listing with images and amenities                                          |
| `POST /properties`                     | admin  | Create a listing                                                               |
| `PATCH /properties/{id}`               | admin  | Update a listing                                                               |
| `DELETE /properties/{id}`              | admin  | Delete (409 if it has bookings)                                                |
| `GET /properties/{id}/availability`    | public | Taken date ranges                                                              |
| `POST /bookings`                       | guest  | Book a property (409 if dates are taken)                                       |
| `GET /bookings`                        | guest  | Own bookings; admin sees all                                                   |
| `GET /bookings/{id}`                   | guest  | One booking                                                                    |
| `POST /bookings/{id}/cancel`           | guest  | Cancel a `pending_payment` booking                                             |
| `POST /blackouts`                      | admin  | Block dates without faking a booking                                           |
| `POST /bookings/{id}/pay`              | guest  | Trigger an M-Pesa STK push                                                     |
| `GET /bookings/{id}/payments`          | guest  | Every payment attempt, newest first                                            |
| `POST /mpesa/callback`                 | —      | Safaricom result callback (verified)                                           |
| `POST /admin/payments/reconcile`       | admin  | Settle payments whose outcome was lost (needs external cron &mdash; see below) |
| `GET /admin/payments/attention`        | admin  | Payments needing a human                                                       |

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

**The M-Pesa callback is never trusted on its own.** Safaricom doesn't sign
callbacks, and the endpoint is public. A callback claiming success is only a
hint: the handler checks the amount against the booking, then asks Safaricom
directly whether the money moved, and confirms only if it agrees. If that
check can't be made, the payment stays `pending` rather than confirming — it
fails closed. The `checkoutRequestId` is never returned to the client, so a
guest can't start a real push, cancel it, and forge their own confirmation.

**Prices are snapshotted.** `bookings.totalAmountCents` is computed server-side
at creation and never recalculated — changing a property's rate must not
change what an existing guest owes. A client-sent total is ignored.

See [CLAUDE.md](./CLAUDE.md) for domain conventions, the Better Auth schema
regeneration procedure, and what is deliberately not built yet.

## Deploying

```sh
docker build -t rentals-api .
```

Migrations are **not** run by the container — with more than one instance they
would race. Run them once per release, before rolling out:

```sh
pnpm db:migrate:deploy      # uses drizzle-orm's migrator, no drizzle-kit needed
```

The image runs as a non-root user, contains no dev dependencies or compiler,
and its healthcheck hits `/health`, which pings the database — so a container
that cannot reach Postgres reports unhealthy rather than serving traffic that
cannot work.

## Reconciliation

`POST /admin/payments/reconcile` **does not run on a timer.** Nothing inside
the API schedules it — point an external cron at it every few minutes before
going live:

```sh
*/5 * * * * curl -fsS -X POST https://your-api/admin/payments/reconcile \
  -H "cookie: <admin session>"
```

It exists because the payment flow deliberately fails closed: whenever it
cannot prove what happened to a payment, it leaves the attempt pending rather
than guessing. Without the sweep, a guest whose callback was lost has paid,
holds a booking that never confirms, and cannot retry. The endpoint is
idempotent, so overlapping runs are harmless.

`GET /admin/payments/attention` lists what the sweep cannot fix by itself —
each entry is real money that may need a refund or a manual confirmation.

## Testing

`./dev.sh` must be running — the suite uses real Postgres. Tests drive the
actual phone+OTP sign-in flow rather than forging session rows.

```sh
pnpm test
```
