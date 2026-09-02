import { createRouter } from "@/lib/create-app";

import * as handlers from "./amenities.handlers";
import * as routes from "./amenities.routes";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.create, handlers.create)
  .openapi(routes.setForProperty, handlers.setForProperty);

export default router;
