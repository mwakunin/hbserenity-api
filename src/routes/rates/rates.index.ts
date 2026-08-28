import { createRouter } from "@/lib/create-app";

import * as handlers from "./rates.handlers";
import * as routes from "./rates.routes";

const router = createRouter()
  .openapi(routes.createOverride, handlers.createOverride)
  .openapi(routes.listForProperty, handlers.listForProperty)
  .openapi(routes.removeOverride, handlers.removeOverride)
  .openapi(routes.quote, handlers.quote);

export default router;
