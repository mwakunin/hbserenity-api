import { createRouter } from "@/lib/create-app";

import * as handlers from "./payments.handlers";
import * as routes from "./payments.routes";

const router = createRouter()
  .openapi(routes.initiate, handlers.initiate)
  .openapi(routes.callback, handlers.callback)
  .openapi(routes.listForBooking, handlers.listForBooking);

export default router;
