import { createRouter } from "@/lib/create-app";

import * as handlers from "./admin.handlers";
import * as routes from "./admin.routes";

const router = createRouter()
  .openapi(routes.reconcile, handlers.reconcile)
  .openapi(routes.attention, handlers.attention);

export default router;
