/* eslint-disable no-console */
import { pool } from "@/db";
import env from "@/env";
import {
  completePastStays,
  paymentsNeedingAttention,
  reconcilePayments,
  releaseUndispatched,
} from "@/lib/reconciliation";
import { closeRedis } from "@/lib/redis";

/**
 * The scheduled reconciliation run.
 *
 * A CLI entry point rather than a call to `POST /admin/payments/reconcile`,
 * because that endpoint needs an admin session and a cron job cannot complete
 * a phone-OTP or email sign-in. The alternative — a shared secret header —
 * would add an authentication path and a credential to rotate for something
 * that never needs to cross the network at all.
 *
 * Runs from the same image as the API, with a different command:
 *
 *   docker run --rm --env-file .env.production <image> \
 *     node ./dist/src/tasks/reconcile.js
 *
 * Safe to run concurrently with itself and with live traffic — every write in
 * the sweep is a compare-and-swap.
 */

function log(fields: object, message: string) {
  // One JSON line per event, so a log collector can read it and cron mail
  // stays legible.
  console.log(JSON.stringify({ level: "info", task: "reconcile", message, ...fields }));
}

function logError(fields: object, message: string) {
  console.error(JSON.stringify({ level: "error", task: "reconcile", message, ...fields }));
}

const logger = {
  info: log,
  warn: log,
  error: logError,
};

async function main() {
  const startedAt = Date.now();
  log({ env: env.NODE_ENV }, "Reconciliation started");

  // Settle attempts whose outcome was never confirmed.
  const payments = await reconcilePayments(logger);

  // Free attempts that never reached a push, so retries are not blocked.
  const releasedUndispatched = await releaseUndispatched();

  // Move finished stays to `completed`. Nothing else advances a booking, so
  // without this no stay ever becomes reviewable.
  const staysCompleted = await completePastStays();

  // Surfaced, not resolved: these need a human. Counted here so a scheduled
  // run is where you notice them growing.
  const attention = await paymentsNeedingAttention();

  log({
    ...payments,
    releasedUndispatched,
    staysCompleted,
    needingAttention: attention.length,
    durationMs: Date.now() - startedAt,
  }, "Reconciliation finished");

  if (attention.length > 0) {
    logError(
      { count: attention.length, reasons: attention.map(a => a.reason) },
      "Payments need manual attention",
    );
  }
}

main()
  .then(async () => {
    await pool.end();
    await closeRedis();
    process.exit(0);
  })
  .catch(async (err) => {
    logError({ err: String(err) }, "Reconciliation failed");
    await pool.end().catch(() => {});
    await closeRedis().catch(() => {});
    // Non-zero so cron, or whatever scheduler runs this, reports a failure
    // rather than silently succeeding forever.
    process.exit(1);
  });
