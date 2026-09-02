import { createRouter } from "@/lib/create-app";

import * as handlers from "./admin.handlers";
import * as routes from "./admin.routes";

const router = createRouter()
  .openapi(routes.reconcile, handlers.reconcile)
  .openapi(routes.recordRefund, handlers.recordRefund)
  .openapi(routes.listRefunds, handlers.listRefunds)
  .openapi(routes.attention, handlers.attention)
  .openapi(routes.listPayments, handlers.listPayments);

export default router;
