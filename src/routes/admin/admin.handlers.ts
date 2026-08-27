import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import {
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

  return c.json({ ...summary, releasedUndispatched }, HttpStatusCodes.OK);
};

export const attention: AppRouteHandler<AttentionRoute> = async (c) => {
  const data = await paymentsNeedingAttention();
  return c.json({ data }, HttpStatusCodes.OK);
};
