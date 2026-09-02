import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { and, gt, lt } from "drizzle-orm";

/**
 * Booking statuses that actually hold dates against other guests — and so
 * exactly the ones that can still be called off. A booking that holds nothing
 * has either already happened or was cancelled once already.
 *
 * This list is also the `WHERE` clause of the `bookings_no_overlap` exclusion
 * constraint. The two must agree: a status the constraint counts but this does
 * not would leave dates held by a booking nothing in the API can see.
 */
export const HOLDING_STATUSES = ["pending_payment", "confirmed"] as const;

/**
 * Whether a stored range `[start, end)` overlaps the window `[from, to)`.
 *
 * True when `start < to AND end > from`. Both sides are half-open, which is
 * what makes back-to-back stays legal: a range ending exactly on `from` has
 * already released that day, and one starting exactly on `to` has not taken
 * it yet. Get either comparison wrong by one and the checkout day stops being
 * bookable by the next guest.
 *
 * It lives here because the same question is asked of bookings, blackouts and
 * rate overrides, by availability, by booking creation, by blackout creation
 * and by the browse filter. Written out at each of those, one of them
 * eventually says `<=`.
 */
export function overlapsWindow(
  start: AnyPgColumn,
  end: AnyPgColumn,
  from: string,
  to: string,
) {
  return and(lt(start, to), gt(end, from));
}
