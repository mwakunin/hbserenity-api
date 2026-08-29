/**
 * The calendar day, as the booking columns store it.
 *
 * `check_in` and `check_out` are `date`, not `timestamp` — a stay is a
 * calendar range, not an instant. Anything comparing "now" against them has to
 * reduce now to the same shape, and every such place must reduce it the *same*
 * way: reconciliation deciding a stay is over and a handler deciding a stay has
 * begun cannot be allowed to disagree about what day it is.
 *
 * UTC rather than Africa/Nairobi, which is where the properties are. Kenya is
 * UTC+3, so for the first three hours of a Kenyan day this still reports
 * yesterday. That is a deliberate trade: one shared definition matters more
 * than three hours of precision, and where it errs it errs in the guest's
 * favour — a stay is judged to have begun slightly later, not sooner.
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
