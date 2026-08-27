import configureOpenAPI from "@/lib/configure-open-api";
import createApp from "@/lib/create-app";
import bookings from "@/routes/bookings/bookings.index";
import health from "@/routes/health.route";
import index from "@/routes/index.route";
import properties from "@/routes/properties/properties.index";

const app = createApp();

configureOpenAPI(app);

const routes = [
  index,
  health,
  properties,
  bookings,
] as const;

routes.forEach((route) => {
  app.route("/", route);
});

export type AppType = typeof routes[number];

export default app;
