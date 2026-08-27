import * as HttpStatusCodes from "stoker/http-status-codes";

import { createRouter } from "@/lib/create-app";

import * as handlers from "./payments.handlers";
import * as routes from "./payments.routes";

const router = createRouter()
  .openapi(routes.initiate, handlers.initiate)
  .openapi(
    routes.callback,
    handlers.callback,
    // Safaricom retries anything that isn't a 200, so the callback must never
    // answer 422.
    //
    // The schema tolerates junk *inside* the envelope, but a body that isn't
    // an object at all — a bare array, a scalar, `null` — still fails
    // validation, and the default hook would turn that into a 422 and an
    // endless retry loop. Acknowledge and drop it instead; the handler already
    // treats every payload as untrusted, so nothing is lost by not parsing it.
    (result, c) => {
      if (!result.success) {
        return c.json(
          { ResultCode: 0, ResultDesc: "Accepted" },
          HttpStatusCodes.OK,
        );
      }
    },
  )
  .openapi(routes.listForBooking, handlers.listForBooking);

export default router;
