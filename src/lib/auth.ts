import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";

import db from "@/db";
import * as authSchema from "@/db/auth-schema";
import env from "@/env";

import { normalizeKenyanPhone } from "./phone";

/**
 * Test seam: the most recent OTP issued per phone number. Populated only when
 * NODE_ENV=test, so the suite can drive the real sign-in flow end to end
 * instead of forging session rows and hoping the cookie format matches.
 */
export const sentOtps = new Map<string, string>();

/**
 * Phone + OTP is the ONLY way to sign in, so an unconfigured SMS provider
 * means nobody can authenticate at all. Refuse to start rather than boot a
 * deployment whose login is silently broken — a failed deploy is visible,
 * whereas "guests cannot sign in" surfaces only once real users hit it.
 *
 * Wiring a provider (Africa's Talking is the usual choice in Kenya) means
 * adding its credentials to env.ts and sending the message in sendOTP below.
 */
if (env.NODE_ENV === "production") {
  throw new Error(
    "No SMS provider is configured, so phone OTP sign-in cannot work. "
    + "Wire one up in src/lib/auth.ts (sendOTP) and add its credentials to "
    + "src/env.ts before deploying to production.",
  );
}

/**
 * Phone + OTP is the primary login method, not email/password — it matches how
 * Kenyan guests actually identify themselves, and the verified number is the
 * same one M-Pesa will charge.
 */
export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),

  // Disabled deliberately: there is no password flow.
  emailAndPassword: { enabled: false },

  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "guest",
        // Never settable from the client — privilege escalation otherwise.
        input: false,
      },
    },
  },

  plugins: [
    phoneNumber({
      otpLength: 6,
      expiresIn: 60 * 5,
      requireVerification: true,

      async sendOTP({ phoneNumber: to, code }) {
        const normalized = normalizeKenyanPhone(to) ?? to;

        if (env.NODE_ENV === "test") {
          sentOtps.set(normalized, code);
          return;
        }

        // Production never reaches here: the startup guard above stops the
        // process before any request is served. Replace that guard and this
        // line together when an SMS provider is wired in.
        console.warn(`[dev] OTP for ${normalized}: ${code}`);
      },

      // A phone-first signup still needs to satisfy the non-null email column
      // Better Auth expects; these placeholders are replaced if the guest
      // later adds a real address.
      signUpOnVerification: {
        getTempEmail: to => `${normalizeKenyanPhone(to) ?? to}@phone.rentals.local`,
        getTempName: to => normalizeKenyanPhone(to) ?? to,
      },
    }),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
