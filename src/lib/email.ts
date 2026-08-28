import { Resend } from "resend";

import env from "@/env";

/**
 * Transactional email. Only verification mail is sent today — booking
 * confirmations and receipts are not built yet.
 */

/** Both halves are required together, so one check covers the feature. */
export const emailEnabled = Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/** Test seam: mail captured instead of sent when NODE_ENV=test. */
export const sentEmails: Array<{ to: string; subject: string; body: string }> = [];

export class EmailError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EmailError";
  }
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  if (env.NODE_ENV === "test") {
    sentEmails.push(input);
    return;
  }

  if (!client || !env.RESEND_FROM_EMAIL) {
    // Callers gate on emailEnabled; reaching here means a configuration bug
    // rather than a deliberate opt-out, so say so loudly.
    throw new EmailError("Email is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)");
  }

  const { error } = await client.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: input.to,
    subject: input.subject,
    text: input.body,
  });

  if (error)
    throw new EmailError(`Resend rejected the message: ${error.message}`, error);
}
