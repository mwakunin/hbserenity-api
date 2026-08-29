/** Where the properties are, and therefore what "today" means to a stay. */
export const BUSINESS_TIME_ZONE = "Africa/Nairobi";

/**
 * The calendar day, as the booking columns store it.
 *
 * `check_in` and `check_out` are `date`, not `timestamp` — a stay is a
 * calendar range, not an instant. Anything comparing "now" against them has to
 * reduce now to the same shape, and every such place must reduce it the *same*
 * way: reconciliation deciding a stay is over and a handler deciding a stay has
 * begun cannot be allowed to disagree about what day it is.
 *
 * That day is Kenya's, not UTC's. The dates on a booking mean local calendar
 * days — a guest arriving on the 1st means the 1st in Nairobi — and Kenya is
 * UTC+3, so for the first three hours of each Kenyan day UTC still reports
 * yesterday. Read in UTC, a stay beginning today looks like it begins tomorrow
 * for those three hours, and one that ended today looks unfinished.
 *
 * The time zone is passed explicitly rather than read from TZ, because the
 * container sets `TZ=UTC` on purpose: the database is UTC and the process must
 * not drift from it. Only this calendar question is local.
 */
const dayParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  // Pinned so the parts are Gregorian and written in Latin digits whatever the
  // host's defaults are.
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayInBusinessZone(): string {
  // Assembled from typed parts rather than read off a formatted string.
  // `toLocaleDateString("en-CA")` happens to print YYYY-MM-DD, but only while
  // en-CA actually resolves; on a build whose ICU data lacks it the call
  // silently falls back and returns something like 9/1/2026. Nothing throws —
  // the string simply stops being comparable to a date column, and
  // `"2026-09-01" <= "9/1/2026"` is true, so every stay would look already
  // begun and every confirmed booking already finished. Taking the parts by
  // name cannot go wrong that way.
  const parts = dayParts.formatToParts(new Date());
  const value = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}
