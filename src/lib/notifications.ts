import { and, eq, inArray } from "drizzle-orm";

import db from "@/db";
import { bookings, payments, properties, user } from "@/db/schema";

import { emailDeliverable, sendEmail } from "./email";
import { RESOLVABLE_STATUSES } from "./payment-settlement";
import { isDeliverableEmail } from "./phone";
import { nightsBetween } from "./pricing";

/**
 * Mail a guest sends and receives around a booking.
 *
 * Everything here is **best-effort and never throws**. A confirmation email
 * that fails must not roll back a payment, turn a settled booking back into an
 * unsettled one, or make the M-Pesa callback answer anything other than 200 —
 * Safaricom retries a non-200 indefinitely. The guest not receiving mail is a
 * bad outcome; the money being recorded wrongly is a far worse one, so the
 * dependency only ever runs one way.
 *
 * Sending happens **after** the transaction that confirmed the booking has
 * committed, and only when that transaction is the one that moved the row.
 * Inside the transaction it could mail a guest about a booking that then rolls
 * back, and without the transition check every retry and reconciliation pass
 * over an already-confirmed booking would mail them again.
 */

interface Logger {
  info: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

/** Shillings from cents, for display only. Money is never stored this way. */
function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString("en-KE")}`;
}

function formatDate(date: string): string {
  // Parsed as UTC deliberately: these are calendar dates, not instants, and
  // constructing them in local time can shift the day.
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Everything a booking email needs, in one read.
 *
 * Returns null if the booking has vanished — possible if it is deleted between
 * the commit and this call, and not worth failing over.
 */
async function loadBookingContext(bookingId: string) {
  const [row] = await db.select({
    reference: bookings.id,
    checkIn: bookings.checkIn,
    checkOut: bookings.checkOut,
    guestCount: bookings.guestCount,
    cancellationReason: bookings.cancellationReason,
    totalAmountCents: bookings.totalAmountCents,
    currency: bookings.currency,
    guestName: user.name,
    guestEmail: user.email,
    propertyTitle: properties.title,
    county: properties.county,
    town: properties.town,
  })
    .from(bookings)
    .innerJoin(user, eq(user.id, bookings.guestId))
    .innerJoin(properties, eq(properties.id, bookings.propertyId))
    .where(eq(bookings.id, bookingId));

  return row ?? null;
}

/**
 * Tell the guest their stay is confirmed.
 *
 * Call this only when the caller's own transaction moved the booking to
 * `confirmed`, and only after it committed.
 */
export async function notifyBookingConfirmed(
  bookingId: string,
  log: Logger,
): Promise<void> {
  try {
    if (!emailDeliverable)
      return;

    const booking = await loadBookingContext(bookingId);
    if (!booking)
      return;

    // A phone-first signup has a placeholder address that satisfies the NOT
    // NULL column and can never receive anything. Sending there is a
    // guaranteed bounce, which harms the sending domain's reputation for
    // nothing.
    if (!isDeliverableEmail(booking.guestEmail)) {
      log.info(
        { bookingId },
        "Booking confirmed but the guest has no deliverable email address",
      );
      return;
    }

    const nights = nightsBetween(booking.checkIn, booking.checkOut);

    await sendEmail({
      to: booking.guestEmail,
      subject: `Your stay at ${booking.propertyTitle} is confirmed`,
      body: [
        `Hi ${booking.guestName},`,
        "",
        "Your payment came through and your booking is confirmed.",
        "",
        `  ${booking.propertyTitle}`,
        `  ${booking.town}, ${booking.county}`,
        "",
        `  Check in   ${formatDate(booking.checkIn)}`,
        `  Check out  ${formatDate(booking.checkOut)}`,
        `  ${nights} night${nights === 1 ? "" : "s"}, ${booking.guestCount} guest${booking.guestCount === 1 ? "" : "s"}`,
        "",
        `  Total paid ${formatMoney(booking.totalAmountCents, booking.currency)}`,
        `  Reference  ${booking.reference}`,
        "",
        "We look forward to hosting you. Reply to this email if anything needs changing.",
      ].join("\n"),
    });
  }
  catch (err) {
    // Swallowed on purpose. See the note at the top of this file: the payment
    // is already recorded, and failing here would undo or obscure that.
    log.error({ err, bookingId }, "Could not send the booking confirmation email");
  }
}

/**
 * What to tell the guest about money, without ever overstating certainty.
 *
 * The negative claim is the dangerous one: told "nothing to refund", a guest
 * has no reason to chase a charge that lands afterwards. It is therefore only
 * made when nothing can still settle.
 */
function refundLine(paidCents: number, inFlight: boolean, currency: string): string {
  if (paidCents > 0) {
    return `You paid ${formatMoney(paidCents, currency)} for this stay. `
      + `We are arranging your refund and will confirm once it has been sent.`;
  }

  if (inFlight) {
    return `A payment for this stay had not finished when it was cancelled. `
      + `If it goes through, we will refund it and confirm once it has been sent.`;
  }

  return `No payment was taken, so there is nothing to refund.`;
}

/**
 * Tell the guest their stay was called off.
 *
 * Sent whichever side cancelled: the guest gets written confirmation of their
 * own decision, and if the host cancelled, this may be the first they hear of
 * it.
 *
 * Where money was taken it says a refund is being arranged and stops there. It
 * cannot promise an amount, because refunds are recorded by hand against
 * whatever the host decides — a figure quoted here would be a commitment
 * nothing in the system is bound to.
 */
export async function notifyBookingCancelled(
  bookingId: string,
  log: Logger,
): Promise<void> {
  try {
    if (!emailDeliverable)
      return;

    const booking = await loadBookingContext(bookingId);
    if (!booking || !isDeliverableEmail(booking.guestEmail))
      return;

    // Every successful attempt, summed — not the first row found. A booking
    // can hold more than one: `payments_one_pending_per_booking` constrains
    // only pending rows, and the duplicate-charge path exists precisely
    // because a prompt can be answered after the booking was already settled.
    // Quoting one attempt would understate what the guest is actually owed.
    const settled = await db.select({ amountCents: payments.amountCents })
      .from(payments)
      .where(and(
        eq(payments.bookingId, bookingId),
        eq(payments.status, "success"),
      ));

    const paidCents = settled.reduce((total, p) => total + p.amountCents, 0);

    // A prompt may still be sitting on the guest's handset. Cancelling does
    // not retract it, and a callback arriving afterwards records the charge
    // against this now-cancelled booking — the case the attention list calls
    // paid_but_cancelled. So "nothing was taken" is a claim this cannot make
    // while an attempt is unresolved; it would tell the guest not to expect a
    // refund they are in fact owed.
    const [inFlight] = await db.select({ id: payments.id })
      .from(payments)
      .where(and(
        eq(payments.bookingId, bookingId),
        inArray(payments.status, [...RESOLVABLE_STATUSES]),
      ));

    await sendEmail({
      to: booking.guestEmail,
      subject: `Your booking at ${booking.propertyTitle} has been cancelled`,
      body: [
        `Hi ${booking.guestName},`,
        "",
        `Your booking at ${booking.propertyTitle} for `
        + `${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)} `
        + `has been cancelled.`,
        "",
        `  Reference  ${booking.reference}`,
        booking.cancellationReason ? `  Reason     ${booking.cancellationReason}` : null,
        "",
        refundLine(paidCents, Boolean(inFlight), booking.currency),
        "",
        "Reply to this email if anything looks wrong.",
      ].filter(line => line !== null).join("\n"),
    });
  }
  catch (err) {
    log.error({ err, bookingId }, "Could not send the booking cancellation email");
  }
}

/**
 * The receipt for one payment attempt.
 *
 * Separate from the confirmation because they answer different questions —
 * "am I booked?" and "what was I charged?" — and because a payment can succeed
 * against a booking that was cancelled while the push was in flight. That case
 * gets a receipt and no confirmation, which is exactly right: the guest is out
 * of pocket and needs the record, and telling them the stay is confirmed would
 * be a lie.
 */
export async function notifyPaymentReceipt(
  paymentId: string,
  log: Logger,
): Promise<void> {
  try {
    if (!emailDeliverable)
      return;

    const [payment] = await db.select({
      amountCents: payments.amountCents,
      receipt: payments.mpesaReceiptNumber,
      phoneNumber: payments.phoneNumber,
      bookingId: payments.bookingId,
    })
      .from(payments)
      .where(eq(payments.id, paymentId));

    if (!payment)
      return;

    const booking = await loadBookingContext(payment.bookingId);
    if (!booking || !isDeliverableEmail(booking.guestEmail))
      return;

    await sendEmail({
      to: booking.guestEmail,
      subject: `Payment received for ${booking.propertyTitle}`,
      body: [
        `Hi ${booking.guestName},`,
        "",
        `We have received ${formatMoney(payment.amountCents, booking.currency)} by M-Pesa.`,
        "",
        `  Paid from    ${payment.phoneNumber}`,
        payment.receipt ? `  M-Pesa code  ${payment.receipt}` : null,
        `  Booking      ${booking.reference}`,
        `  Stay         ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}`,
        "",
        "Keep this email as your receipt.",
      ].filter(line => line !== null).join("\n"),
    });
  }
  catch (err) {
    log.error({ err, paymentId }, "Could not send the payment receipt email");
  }
}
