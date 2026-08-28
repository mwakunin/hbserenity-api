const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parses a `YYYY-MM-DD` date column value as a UTC midnight timestamp. */
function parseDate(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** `YYYY-MM-DD` for a UTC timestamp. */
function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

/**
 * Whether a night is charged at the weekend rate.
 *
 * A night is named by the date the guest sleeps there, so Friday and Saturday
 * nights are the weekend — someone arriving Friday and leaving Sunday pays two
 * weekend nights. Sunday night is not one.
 */
export function isWeekendNight(night: string): boolean {
  const day = new Date(parseDate(night)).getUTCDay();
  return day === 5 || day === 6;
}

export interface RateOverride {
  /** Half-open `[startDate, endDate)`, as everywhere else. */
  startDate: string;
  endDate: string;
  pricePerNightCents: number;
}

export interface PricedProperty {
  pricePerNightCents: number;
  cleaningFeeCents: number;
  /** Null or absent means weekends cost the same as any other night. */
  weekendPriceCents?: number | null;
}

/**
 * What one night costs.
 *
 * Precedence is deliberate: an explicit date range beats the recurring
 * weekend rule, which beats the base rate. A season priced for Christmas
 * should not be quietly overridden because the 25th happens to be a Friday.
 */
export function nightlyRate(
  property: PricedProperty,
  night: string,
  overrides: readonly RateOverride[] = [],
): number {
  const override = overrides.find(o => night >= o.startDate && night < o.endDate);
  if (override)
    return override.pricePerNightCents;

  if (isWeekendNight(night) && property.weekendPriceCents != null)
    return property.weekendPriceCents;

  return property.pricePerNightCents;
}

/**
 * Longest stay the pricing code will expand night by night.
 *
 * `nightlyBreakdown` allocates one object per night, so an unbounded range is
 * a denial of service on any endpoint that reaches it — a public quote for
 * 2020 to 9999 is nearly three million objects and around 175MB of JSON. A
 * year is far beyond any real short-term rental stay.
 */
export const MAX_STAY_NIGHTS = 365;

export interface NightBreakdown {
  night: string;
  rateCents: number;
  /** Why this rate applied, so a quote can explain itself. */
  reason: "override" | "weekend" | "base";
}

/** Per-night rates for a stay, in order. */
export function nightlyBreakdown(
  property: PricedProperty,
  checkIn: string,
  checkOut: string,
  overrides: readonly RateOverride[] = [],
): NightBreakdown[] {
  const nights = nightsBetween(checkIn, checkOut);

  if (nights <= 0)
    throw new Error("Check-out must be after check-in");

  // Backstop. Request schemas reject an over-long stay as a 422 before
  // reaching here; this exists so a future caller that forgets cannot
  // allocate its way through the heap.
  if (nights > MAX_STAY_NIGHTS)
    throw new Error(`Stay exceeds ${MAX_STAY_NIGHTS} nights`);

  const start = parseDate(checkIn);

  return Array.from({ length: nights }, (_, i) => {
    const night = formatDate(start + i * MS_PER_DAY);
    const rateCents = nightlyRate(property, night, overrides);

    const isOverride = overrides.some(o => night >= o.startDate && night < o.endDate);
    const reason: NightBreakdown["reason"] = isOverride
      ? "override"
      : isWeekendNight(night) && property.weekendPriceCents != null
        ? "weekend"
        : "base";

    return { night, rateCents, reason };
  });
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
  overrides: readonly RateOverride[] = [],
): number {
  const nights = nightlyBreakdown(property, checkIn, checkOut, overrides);

  // The cleaning fee is charged once per stay, not per night.
  return nights.reduce((sum, n) => sum + n.rateCents, property.cleaningFeeCents);
}
