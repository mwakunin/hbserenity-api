import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";

import type { Session } from "./auth";

export type UserRole = "guest" | "host" | "admin";

/** The Better Auth user, narrowed with the `role` additional field. */
export type AuthUser = Session["user"] & { role: string };

export interface AppBindings {
  Variables: {
    logger: PinoLogger;
    user: AuthUser | null;
    session: Session["session"] | null;
  };
};

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
