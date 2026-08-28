# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

A short-term rental management platform for Kenya (Airbnb-style). **Single
host** — you own and manage the properties; guests browse publicly and must
sign in and book, then pay by M-Pesa STK push. A booking is
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
  in-memory limiters because counters must be shared across instances; N
  in-memory limiters allow N times the traffic. See the conventions below.
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
  or `→ cancelled` from `pending_payment`. The last step is applied by
  `completePastStays()` in the reconciliation sweep once check-out has passed
  — nothing else advances a booking, so without that sweep running no stay
  ever becomes reviewable. Don't add new statuses without
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
  when Safaricom _answered and refused_ (HTTP < 500). A 5xx, a timeout or a
  network error is not proof that no prompt exists.

  And because a _succeeded_ attempt no longer holds the pending-only unique
  index, the booking status is re-read **under a row lock** immediately before
  inserting a new attempt. The check at the top of `initiate` is stale by then:
  `releaseStaleAttempt` makes network calls, and a callback can confirm the
  booking inside that window.

- **Everything that settles a payment goes through
  `lib/payment-settlement.ts`.** The retry path, the callback and
  reconciliation all need identical rules, and when they each had their own
  copy they drifted — 1001 ("transaction in process") ended up terminal in one
  and still-live in another. `settleAttemptFromProvider()` is the only place
  that asks Safaricom and applies the verdict. Do not reimplement it.

- **Reconciliation is what makes failing closed safe.** The payment flow
  deliberately leaves an attempt pending whenever it cannot prove what
  happened. `lib/reconciliation.ts` is what eventually resolves those:
  `POST /admin/payments/reconcile` sweeps and settles (nothing schedules it —
  point an external cron at it), and
  `GET /admin/payments/attention` lists what it cannot fix — a push dispatched
  with no reference, a possible duplicate charge, money against a cancelled
  booking, an attempt stuck pending. Both are admin-only and the sweep is
  idempotent, so running it twice at once settles nothing twice.

- **Sending a prompt is an external side effect, so one window is
  irreducible.** The booking is checked and the attempt inserted (with
  `pushDispatchedAt`) in a single locked transaction, but the push itself
  happens after that commit. A late callback for an earlier attempt can
  confirm the booking in between. Closing that would mean holding a row lock
  across a network call, which stalls the callback and risks exhausting the
  connection pool — so the outcome is made _visible_ instead: after a
  successful push the booking is re-read, and a prompt sent against an
  already-settled booking is flagged on the payment for refund review. Keep
  that flag; it is the only trace of a genuine duplicate charge.

- **A review belongs to a booking, not a property.** That is what makes it
  trustworthy: only the guest on the booking may write one, only once the stay
  is `completed`, and only once ever. `reviews_booking_idx` is unique, which
  is the real guard — two concurrent submissions both pass the handler checks.
  `propertyId` and `guestId` come from the booking and never from the request,
  or a guest could attach a review to somewhere they never stayed.

  The public listing exposes the reviewer's **name only**, never their id or
  contact details, and the average is computed across every review rather than
  the page returned.

- **Rate limits are per endpoint group, not global** (`middlewares/rate-limit.ts`),
  because abusing different endpoints costs wildly different amounts. An STK
  push spends money and rings a real phone; browsing listings costs a query.
  The presets in `rateLimits` are the vocabulary — add to those rather than
  hand-rolling numbers at a call site.

  Signed-in callers are keyed by **account, not address**, so one person on a
  NAT'd or shared connection cannot exhaust everyone else's budget, and
  changing networks is not a way around a limit.

  Anonymous callers are keyed by an address resolved in `lib/client-ip.ts`,
  **never by a raw header**. `X-Forwarded-For` is written by the sender, so
  reading its leftmost entry means rotating the header yields a fresh counter
  per request — no rate limiting at all. Resolution uses the socket address
  unless `TRUST_PROXY_HOPS` declares how many of your own proxies sit in
  front; the trustworthy entry is then counted from the RIGHT, where your edge
  wrote it. Set that variable to the real hop count: too high reintroduces the
  bypass, and 0 (the default) is correct for direct exposure.

  The limiter **fails open**: if Redis is unreachable the request is allowed
  and the degradation logged. A cache outage must not become a total outage,
  and the endpoints that matter have structural guards anyway — one pending
  payment per booking, the booking overlap constraint.

  Two endpoints are deliberately **not** limited: `POST /mpesa/callback`,
  because Safaricom retries and a dropped callback loses track of real money;
  and `GET /health`, because monitoring hits it constantly and throttling it
  would fake an outage.

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

- **Transactional mail is best-effort and hangs off a transition, not a
  state.** `lib/notifications.ts` never throws: a confirmation that fails must
  not roll back a payment, and the M-Pesa callback must keep answering 200 or
  Safaricom retries forever. Sending happens **after** the confirming
  transaction commits — inside it, a rollback would leave the guest holding a
  confirmation for a booking that does not exist.

  `confirmPaidBooking()` in `lib/payment-settlement.ts` is the single place a
  booking moves to `confirmed`, used by both the callback and the settlement
  path, and it returns **whether this call moved the row**. That boolean is
  what makes the confirmation fire exactly once: both paths are idempotent, so
  without it every reconciliation sweep over a confirmed booking mails the
  guest again.

  A receipt and a confirmation are separate on purpose. A payment can succeed
  against a booking cancelled while the push was in flight — that gets a
  receipt and no confirmation, because the guest is out of pocket and needs
  the record, but telling them the stay is confirmed would be a lie.

  Guests who signed up by phone hold a `@phone.rentals.local` placeholder
  address that satisfies the NOT NULL column and can never receive anything;
  `isDeliverableEmail()` keeps mail from being sent there. Senders gate on
  `emailDeliverable`, **not** `emailEnabled` — the latter also decides whether
  Better Auth requires email verification, and turning that on under test
  would stop sign-up returning a session. Under test `sendEmail` captures into
  `sentEmails` rather than calling Resend, so senders must still run or the
  tests assert nothing.

- **Photos are uploaded by the client, straight to ImageKit.** The API only
  signs the request (`POST /properties/{id}/images/upload-auth`, admin-only,
  five-minute expiry) and records the result. Proxying the bytes would put
  multi-megabyte uploads in the request path of an API whose every other
  endpoint is small and transactional, for no gain — ImageKit stores the file
  either way.

  The client reports where the file landed, so `isOwnCdnUrl()` rejects
  anything not on the configured endpoint. Unchecked, a listing could be
  pointed at any host on the internet, including one that serves something
  else later. That prefix must end at a **segment boundary** — a bare
  `startsWith` on an endpoint of `/account` also accepts `/account-other/...`,
  a different account on the same host.

  The url and the fileId arrive as two independent claims, so `attach`
  resolves the id against ImageKit and stores the url **ImageKit reports**. A
  mismatched pair — easy for a gallery uploading several files at once to
  produce — would otherwise record one file's address against another's
  handle, and deleting that row would remove the unrelated file while leaving
  the displayed one orphaned. If ImageKit cannot be reached, the attach fails
  with 502 rather than storing an unverified pair.

  `property_images.fileId` is NOT NULL and unique. It is ImageKit's handle and
  the only way to delete the stored file — without it a removed photo stays on
  the CDN forever, billed and unreferenced. Deletion therefore removes the CDN
  copy **first** and keeps the row on failure (502), because dropping the row
  on a failed delete strands a file nothing references and no id can find. A
  404 from ImageKit counts as success, so a retry after a partial failure
  still completes.

  One cover per property, enforced by the partial unique index
  `property_images_one_cover_idx`. Two covers has no defined answer, and a
  check-then-update cannot prevent it — both requests read "no other cover".
  The handlers clear then set for the ordinary case and map `23505` to 409.

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

- **Nightly price resolves in one place**, `nightlyRate()` in
  `lib/pricing.ts`, with a deliberate precedence: a `property_rate_overrides`
  row for the date wins, then the property's optional Friday/Saturday
  `weekendPriceCents`, then the base rate. An explicit season must beat a
  recurring rule, or a Christmas price would be undercut whenever the date
  landed on a Friday.

  Overrides are half-open like everything else, and cannot overlap —
  `property_rate_overrides_no_overlap` is an EXCLUDE constraint, because a
  night with two prices has no defined answer and a pre-check cannot stop two
  concurrent inserts.

  The booking reads overrides **inside the same transaction, under the
  property lock**, so a snapshot cannot be taken against rates that changed
  midway. Rate writes take that same lock. For an _insert_ that is belt and
  braces — the foreign key to `properties` already takes a KEY SHARE lock that
  conflicts — but a _delete_ touches no such key, so without it a removal
  could land inside a booking's price computation.

  Stays are capped at `MAX_STAY_NIGHTS`. Pricing expands a stay night by
  night, so an uncapped range on the public quote is a denial of service
  rather than a large answer: 2020 to 9999 is ~2.9 million objects and ~175MB
  of JSON. The request schemas reject it as a 422 and `nightlyBreakdown`
  throws as a backstop. `GET /properties/{id}/quote` runs the identical calculation, so the two agree
  for a given set of rates — but they are separate requests and the booking
  snapshots at booking time, so a rate changed in between legitimately yields
  a different total. Don't document it as a held price.

- **Refunds are records, not transfers.** Only a `success` payment can be
  refunded — you cannot return money never taken. Partial refunds are
  allowed, and the total can never exceed the payment.

  That rule spans rows, so no CHECK can express it: it is enforced by a
  `FOR UPDATE` lock on the payment in `recordRefund()`. The foreign key alone
  is not enough — it takes KEY SHARE, which does not conflict with itself, so
  two concurrent refunds would each read the same total and both insert.
  There is a test that exercises that distinction on two connections, because
  neither an in-process concurrency test nor a lock-observation test can tell
  the two apart.

  A fully refunded payment stops appearing in
  `GET /admin/payments/attention`, or every handled case would sit there
  forever and the list would stop being worth reading.

  **`mpesaReference` is required**, and that is load-bearing rather than
  tidiness. Recording a refund clears the payment from the attention list, so
  a record without proof the money moved would let an _intention_ to refund
  erase a real debt — the failure mode the list exists to prevent. The column
  is NOT NULL as well as required in the request schema: the schema gives a
  readable 422, the constraint is the backstop.

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
- **Sign-in methods.** Email+password is the one that works today and is what
  keeps the API bootable. Google is registered only when both
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. **Phone+OTP is fully
  implemented but dormant** — the plugin, columns and endpoints are all in
  place, and `sendOTP` throws in production until an SMS provider is wired.
  Enabling it means three things, not one: implement the send in `sendOTP`
  (it currently throws), add the provider's credentials to `env.ts`, and set
  `phoneOtpEnabled`. Everything around it — plugin, columns, endpoints, the
  OTP verification flow — is already there. Phone remains the right primary for Kenyan guests (the verified
  number is the one M-Pesa charges), so none of it was removed.

  `activeAuthMethods` refuses to start if _no_ method is usable. Email+password
  has no external dependency so that never fires today — the check exists so
  that disabling it later fails loudly instead of serving an API nobody can
  sign in to.

  **Email verification is required wherever mail can be sent** — it tracks
  `emailEnabled` (both `RESEND_API_KEY` and `RESEND_FROM_EMAIL`), which
  production mandates. It matters because `user.email` is UNIQUE: without
  verification, sign-up hands a session to whoever types an address first, and
  they permanently hold it. With it, an unverified sign-up gets **no session**
  and the real owner receives the mail. Account _takeover_ via Google is
  separately prevented by Better Auth's `requireLocalEmailVerified`, which
  defaults to true so an OAuth identity is never linked into an unverified
  local row.

  Residual, and unavoidable without more work: the unverified row still
  occupies the address, so a determined attacker can block registration of an
  email they don't own. They gain nothing from it.

  An email-only guest has no phone number, so `POST /bookings/{id}/pay` needs
  one in the body; it already 422s clearly when neither is available.

- **Identity model resolved**: Better Auth owns `user`, `session`, `account`,
  `verification` in `src/db/auth-schema.ts` (generated via
  `npx @better-auth/cli@latest generate --config src/lib/auth.ts --output
src/db/auth-schema.ts --yes`, phoneNumber plugin enabled — phone+OTP is
  the primary login method, not email/password). There is no separate
  app-level `users` table. `user.role` (`"guest" | "host" | "admin"`) is a
  Better Auth `additionalField`.
- **Five deviations from raw CLI output must be reapplied after regenerating**
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

## CI and deployment

Actions are pinned to **commit SHAs, not tags** — a tag like `v4` is mutable,
and the docker job holds a token with `packages: write`, so whatever it runs
can publish images. The trailing `# v4` comment records the release, and
Dependabot bumps SHA and comment together. Resolve a new pin from the API
(`/repos/<owner>/<repo>/git/ref/tags/<tag>`) rather than by hand;
`pnpm/action-setup` uses annotated tags, so that needs one more hop to reach
the commit.

`.github/workflows/ci.yml` runs three jobs on every PR:

- **test** — lint, typecheck and the full suite against a real Postgres
  service container. Mapped to :5433 so `.env.test` works unchanged.
- **migrations** — applies every migration to an _empty_ database.
  Deliberately separate from the suite: `globalSetup` migrates a database
  earlier runs already touched, so it cannot catch a migration that only
  fails from nothing. Several fixes in this repo's history were exactly that.
- **docker** — builds the image and starts it, asserting it serves requests
  and that `/health` reports the database as down when it is. A built image
  that cannot start is not a passing build.

  On merges to `main` only, it then pushes to GHCR as `:latest` and
  `:sha-<commit>`. Publishing happens **after** the smoke test, so a broken
  image never reaches the registry, and never on pull requests — a PR should
  prove the image builds, not publish one (a fork's token cannot write
  packages regardless). Auth is `GITHUB_TOKEN` with `packages: write`; no
  separate secret to manage or rotate.

  Deploy the sha tag rather than `latest`: `latest` moves, so it is not
  something you can roll back to.

Deployment migrations run `node ./dist/src/db/migrate.js` — inside the image
that is the only form that works, because the runtime stage deliberately has no
package manager. `pnpm db:migrate:deploy` is the same script for contexts that
do have pnpm. Either way it calls drizzle-orm's own migrator
(`src/db/migrate.ts`) rather than `drizzle-kit`. drizzle-kit is a
devDependency and does not exist in a `--prod` image; drizzle-orm is already a
runtime dependency and reads the same journal, so the two stay consistent.

The container does not run migrations itself — several instances would race.

`.github/workflows/reconcile.yml` runs the reconciliation sweep every 10
minutes, as `node ./dist/src/tasks/reconcile.js` inside the published image,
using the whole production env file passed as the single `PRODUCTION_ENV`
secret. One secret rather than a dozen variables, so the reconciler cannot
drift out of step with how the API itself is configured.

Two properties of GitHub's scheduler matter for a job this load-bearing.
Schedules are **best-effort** — queued, not guaranteed on the minute — which
is fine, since the sweep is idempotent and nothing depends on the cadence.
But scheduled workflows are **disabled automatically after 60 days without
repository activity**, and a silently stopped reconciler strands money and
stops stays ever becoming reviewable. If the API runs on a host you control,
prefer a cron entry or systemd timer there running the same command against
the same env file; the workflow exists so scheduling does not _require_ such
a host.

Two settings are required before the workflow runs at all, and it fails rather
than half-working without either: the `PRODUCTION_ENV` secret, and the
`RECONCILE_IMAGE_TAG` Actions variable holding the sha tag production is
running. The tag is deliberately **not** defaulted to `latest` — the sweep
decides what settles a payment, so a reconciler on a different build than the
deployed API can apply rules the API does not share, and `latest` moves by
definition. A failing job is the louder outcome, since GitHub mails about it;
a sweep against the wrong image looks exactly like a correct one.

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
- **Known flake:** `resetDb()` clears rate-limit keys, so if Redis is briefly
  unreachable every test in `rate-limit.test.ts` fails at once in
  `beforeEach` rather than one assertion failing. Seen once in many runs and
  not reproducible. A whole-file failure there means check Redis before
  hunting for a logic bug.
- UUIDs in tests must be **RFC-valid v4** — `1111...1111` fails zod's
  `.uuid()` on the version/variant nibbles and yields a confusing 422.

The tests that matter most are the overlap ones in
`src/routes/bookings/bookings.test.ts`: concurrent races resolving to
exactly one winner, and back-to-back stays still succeeding. They are the
difference between "we check for overlaps" and "overlaps are impossible."
Don't weaken them.

## Not built yet

Deliberately deferred — don't assume these exist:

- **Refunds.** A payment can succeed against a booking the guest cancelled
  while the push was in flight, and a prompt can be flagged as a possible
  duplicate charge. Both are recorded truthfully and surfaced by
  `GET /admin/payments/attention`, but there is no reversal API call — a
  human still has to send the money back.
- **An SMS provider**, so phone OTP is dormant. The plugin, columns and
  endpoints are all present and `sendOTP` throws in production.
  Email+password is the working sign-in method meanwhile.
- **Partial deposits.** A payment is all-or-nothing against
  `bookings.totalAmountCents`, though 50%-now-balance-later is common
  locally.
- **Cancellation metadata** — no `cancelledAt` and no reason. Refunds
  themselves are recorded; what is missing is why the booking ended.
- **A booking idempotency key**, so a double-tapped "Book now" can create two
  bookings for different dates. The same dates are already impossible — the
  overlap constraint sees to that.
- **`payouts`** — dropped from the schema. With a single host, guest money
  lands directly in your paybill; there is no platform→host payout leg. It
  returns only when a second host is onboarded.
- **The `date_holds` refactor.** Bookings and blackouts are separate tables,
  so booking-vs-blackout overlap needs a row lock rather than a constraint.
  Collapsing them would make it structural. Optional — the lock is correct
  and tested — but worth doing if a third source of held dates appears, such
  as channel-manager sync.
