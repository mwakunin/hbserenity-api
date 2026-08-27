const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parses a `YYYY-MM-DD` date column value as a UTC midnight timestamp. */
function parseDate(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Nights between two check dates. Check-in and check-out are calendar dates
 * (half-open, `[checkIn, checkOut)`), so 27th -> 30th is three nights and the
 * 30th is free for the next guest. Computed in UTC so a DST transition can't
 * turn a night into 23 or 25 hours and round wrong.
 */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((parseDate(checkOut) - parseDate(checkIn)) / MS_PER_DAY);
}

export interface PricedProperty {
  pricePerNightCents: number;
  cleaningFeeCents: number;
}

/**
 * The single source of truth for what a stay costs. The result is snapshotted
 * onto `bookings.totalAmountCents` at creation time and must never be
 * recomputed later — the property's price can change, the booking's cannot.
 *
 * Never trust a client-supplied total; always call this.
 */
export function calculateBookingTotal(
  property: PricedProperty,
  checkIn: string,
  checkOut: string,
): number {
  const nights = nightsBetween(checkIn, checkOut);

  if (nights <= 0)
    throw new Error("Check-out must be after check-in");

  return nights * property.pricePerNightCents + property.cleaningFeeCents;
}
