import configureOpenAPI from "@/lib/configure-open-api";
import createApp from "@/lib/create-app";
import admin from "@/routes/admin/admin.index";
import bookings from "@/routes/bookings/bookings.index";
import health from "@/routes/health.route";
import index from "@/routes/index.route";
import payments from "@/routes/payments/payments.index";
import properties from "@/routes/properties/properties.index";
import rates from "@/routes/rates/rates.index";
import reviews from "@/routes/reviews/reviews.index";

const app = createApp();

configureOpenAPI(app);

const routes = [
  index,
  health,
  properties,
  bookings,
  payments,
  reviews,
  rates,
  admin,
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

export type AppType = typeof routes[number];

export default app;
