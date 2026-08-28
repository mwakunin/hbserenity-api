import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import {
  completePastStays,
  paymentsNeedingAttention,
  reconcilePayments,
  releaseUndispatched,
} from "@/lib/reconciliation";

import type { AttentionRoute, ReconcileRoute } from "./admin.routes";

export const reconcile: AppRouteHandler<ReconcileRoute> = async (c) => {
  const summary = await reconcilePayments(c.var.logger);

  // Attempts that never reached a push hold nothing real, so freeing them is
  // safe and unblocks the guest's retries.
  const releasedUndispatched = await releaseUndispatched();

  // Stays that have ended move to `completed`, which is what makes them
  // reviewable. Nothing else advances a booking past `confirmed`.
  const staysCompleted = await completePastStays();

  return c.json(
    { ...summary, releasedUndispatched, staysCompleted },
    HttpStatusCodes.OK,
  );
};

export const attention: AppRouteHandler<AttentionRoute> = async (c) => {
  const data = await paymentsNeedingAttention();
  return c.json({ data }, HttpStatusCodes.OK);
};
