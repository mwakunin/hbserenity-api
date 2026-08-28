import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";

import db from "@/db";
import * as authSchema from "@/db/auth-schema";
import env from "@/env";

import { emailEnabled, sendEmail } from "./email";
import { normalizeKenyanPhone, PLACEHOLDER_EMAIL_DOMAIN } from "./phone";

/**
 * Test seam: the most recent OTP issued per phone number. Populated only when
 * NODE_ENV=test, so the suite can drive the real sign-in flow end to end
 * instead of forging session rows and hoping the cookie format matches.
 */
export const sentOtps = new Map<string, string>();

/** Google sign-in needs both halves of the credential pair, or neither. */
export const googleEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
);

/**
 * Phone OTP is fully implemented but cannot deliver a code until an SMS
 * provider is wired in `sendOTP` below. It stays dormant rather than removed:
 * the plugin, its columns and its endpoints are all in place, so enabling it
 * later is a credentials change, not a code change.
 */
export const phoneOtpEnabled = false;

/**
 * Sign-in methods that actually work right now.
 *
 * Email+password always does — it has no external dependency — which is what
 * lets the API boot while SMS is deferred. The check is kept anyway: if
 * someone later disables it without enabling another method, a deployment
 * whose login is silently broken should fail loudly rather than serve traffic
 * nobody can sign in to.
 */
export const activeAuthMethods = [
  "email_password",
  ...(googleEnabled ? ["google" as const] : []),
  ...(phoneOtpEnabled ? ["phone_otp" as const] : []),
];

if (activeAuthMethods.length === 0) {
  throw new Error(
    "No sign-in method is usable, so nobody could authenticate. Enable "
    + "email+password, configure Google, or wire an SMS provider for phone OTP.",
  );
}

/**
 * Email+password is the working method today; Google is enabled when
 * credentials are present; phone+OTP is kept for when the client wants it.
 *
 * Phone remains the right primary for Kenyan guests — the verified number is
 * the one M-Pesa charges — so none of that code has been removed.
 */
export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),

  emailAndPassword: {
    enabled: true,
    /**
     * Verification is required wherever mail can actually be sent — which is
     * production, since RESEND_* is mandatory there.
     *
     * Without it, sign-up hands out a session for an address nobody proved
     * they own. `user.email` is UNIQUE, so an attacker can register someone
     * else's address and permanently block the real owner from ever
     * registering it. (OAuth takeover is separately prevented: Better Auth's
     * `requireLocalEmailVerified` defaults to true, so a Google identity is
     * never linked into an unverified local row.)
     *
     * Off in dev and test only because there is no mail provider there.
     */
    requireEmailVerification: emailEnabled,
    minPasswordLength: 10,
  },

  emailVerification: {
    sendOnSignUp: emailEnabled,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user: recipient, url }) {
      await sendEmail({
        to: recipient.email,
        subject: "Confirm your email address",
        body: `Confirm your email address to finish setting up your account:\n\n${url}\n\n`
          + `If you didn't sign up you can ignore this message — the account cannot be used until it is confirmed.`,
      });
    },
  },

  // Only registered when both credentials are present — Better Auth would
  // otherwise advertise a provider that cannot complete a round trip.
  ...(googleEnabled
    ? {
        socialProviders: {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
          },
        },
      }
    : {}),

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

        // Dormant in production until an SMS provider is wired: fail loudly
        // rather than silently not delivering a code. Replace this line and
        // flip phoneOtpEnabled together when that happens.
        if (env.NODE_ENV === "production") {
          throw new Error(
            "Phone OTP is not available: no SMS provider is configured. "
            + "Wire one up in src/lib/auth.ts (sendOTP), add its credentials "
            + "to src/env.ts, and set phoneOtpEnabled.",
          );
        }

        console.warn(`[dev] OTP for ${normalized}: ${code}`);
      },

      // A phone-first signup still needs to satisfy the non-null email column
      // Better Auth expects; these placeholders are replaced if the guest
      // later adds a real address.
      signUpOnVerification: {
        getTempEmail: to => `${normalizeKenyanPhone(to) ?? to}@${PLACEHOLDER_EMAIL_DOMAIN}`,
        getTempName: to => normalizeKenyanPhone(to) ?? to,
      },
    }),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
