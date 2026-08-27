import { createRouter } from "@/lib/create-app";

import * as handlers from "./bookings.handlers";
import * as routes from "./bookings.routes";

const router = createRouter()
  .openapi(routes.availability, handlers.availability)
  .openapi(routes.create, handlers.create)
  .openapi(routes.list, handlers.list)
  .openapi(routes.getOne, handlers.getOne)
  .openapi(routes.cancel, handlers.cancel)
  .openapi(routes.createBlackout, handlers.createBlackout);

export default router;
