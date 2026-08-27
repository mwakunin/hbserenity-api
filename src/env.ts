/* eslint-disable node/no-process-env */
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import path from "node:path";
import { z } from "zod";

expand(config({
  path: path.resolve(
    process.cwd(),
    process.env.NODE_ENV === "test" ? ".env.test" : ".env",
  ),
}));

/**
 * Credentials that are only needed once the payment / email / media features
 * land. They're optional in dev and test so the API boots without them, but
 * required in production — enforced in the superRefine below.
 */
const PRODUCTION_REQUIRED = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
  "RESEND_API_KEY",
  "IMAGEKIT_PUBLIC_KEY",
  "IMAGEKIT_PRIVATE_KEY",
  "IMAGEKIT_URL_ENDPOINT",
] as const;

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(9999),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),

  // --- Data stores ---
  DATABASE_URL: z.url(),
  TEST_DATABASE_URL: z.url().optional(),
  REDIS_URL: z.url(),

  // --- Auth (Better Auth) ---
  BETTER_AUTH_SECRET: z.string().min(32, "Must be at least 32 characters"),
  BETTER_AUTH_URL: z.url(),

  // --- M-Pesa ---
  // Picks the Daraja host: sandbox.safaricom.co.ke vs api.safaricom.co.ke.
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_CALLBACK_URL: z.url().optional(),
  /**
   * Comma-separated Safaricom source IPs permitted to POST the callback.
   * Safaricom does not sign callbacks, so this is one of the few things that
   * distinguishes a real one. Optional because the published list changes;
   * when empty the endpoint relies on its other checks instead.
   */
  MPESA_CALLBACK_ALLOWED_IPS: z.string().optional(),

  // --- Email (Resend) ---
  RESEND_API_KEY: z.string().optional(),

  // --- Image CDN (ImageKit) ---
  IMAGEKIT_PUBLIC_KEY: z.string().optional(),
  IMAGEKIT_PRIVATE_KEY: z.string().optional(),
  IMAGEKIT_URL_ENDPOINT: z.url().optional(),
})
  .superRefine((input, ctx) => {
    if (input.NODE_ENV === "production") {
      for (const key of PRODUCTION_REQUIRED) {
        if (!input[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Must be set when NODE_ENV is 'production'",
          });
        }
      }

      if (input.MPESA_CALLBACK_URL && !input.MPESA_CALLBACK_URL.startsWith("https://")) {
        ctx.addIssue({
          code: "custom",
          path: ["MPESA_CALLBACK_URL"],
          message: "Must be a publicly reachable HTTPS URL",
        });
      }
    }

    // Guard against a stray `pnpm test` running against — and truncating —
    // the development database.
    if (input.NODE_ENV === "test" && !input.TEST_DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["TEST_DATABASE_URL"],
        message: "Must be set when NODE_ENV is 'test'",
      });
    }
  })
  .transform(input => ({
    ...input,
    // Everything downstream reads DATABASE_URL; in test it resolves to the
    // disposable test database so no caller has to remember the distinction.
    DATABASE_URL: input.NODE_ENV === "test" && input.TEST_DATABASE_URL
      ? input.TEST_DATABASE_URL
      : input.DATABASE_URL,
  }));

export type env = z.infer<typeof EnvSchema>;

// eslint-disable-next-line ts/no-redeclare
const { data: env, error } = EnvSchema.safeParse(process.env);

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(z.flattenError(error).fieldErrors, null, 2));
  process.exit(1);
}

export default env!;
