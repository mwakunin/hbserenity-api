import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";

import db from "@/db";
import * as authSchema from "@/db/auth-schema";
import env from "@/env";

import { normalizeKenyanPhone } from "./phone";

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

        if (env.NODE_ENV === "production") {
          // TODO: wire an SMS provider (Africa's Talking / Twilio) before
          // going live. Failing loudly beats silently not delivering an OTP.
          throw new Error(
            "No SMS provider configured — cannot deliver OTP in production",
          );
        }

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
