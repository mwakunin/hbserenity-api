import { createRouter } from "@/lib/create-app";

import * as handlers from "./images.handlers";
import * as routes from "./images.routes";

const router = createRouter()
  .openapi(routes.createUploadAuth, handlers.createUploadAuth)
  .openapi(routes.attach, handlers.attach)
  .openapi(routes.listForProperty, handlers.listForProperty)
  .openapi(routes.patch, handlers.patch)
  .openapi(routes.remove, handlers.remove);

export default router;
