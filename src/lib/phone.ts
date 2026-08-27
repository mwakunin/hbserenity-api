/**
 * Kenyan phone numbers arrive in at least four shapes: `0712345678`,
 * `+254712345678`, `254712345678` and `712345678`, often with spaces, dashes
 * or parentheses. M-Pesa STK push needs one canonical form, and the same
 * number must resolve to the same user account however it was typed — so
 * normalize on input, never at payment time.
 *
 * Kenyan mobile national significant numbers are 9 digits beginning with 7
 * (Safaricom/Airtel/Telkom) or 1 (the newer 011x Safaricom range).
 */

const KENYA_COUNTRY_CODE = "254";
const NSN_PATTERN = /^[71]\d{8}$/;

/**
 * Normalize a Kenyan phone number to E.164 (`+2547XXXXXXXX`).
 *
 * @returns the normalized number, or `null` if it isn't a valid Kenyan mobile.
 */
export function normalizeKenyanPhone(input: string): string | null {
  if (typeof input !== "string")
    return null;

  // Strip everything that isn't a digit or a leading plus.
  const cleaned = input.trim().replace(/[\s\-()./]/g, "");

  if (!/^\+?\d+$/.test(cleaned))
    return null;

  let digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;

  if (digits.startsWith(KENYA_COUNTRY_CODE))
    digits = digits.slice(KENYA_COUNTRY_CODE.length);
  else if (digits.startsWith("0"))
    digits = digits.slice(1);

  if (!NSN_PATTERN.test(digits))
    return null;

  return `+${KENYA_COUNTRY_CODE}${digits}`;
}

/** Throwing variant, for call sites where a bad number is a programming error. */
export function assertKenyanPhone(input: string): string {
  const normalized = normalizeKenyanPhone(input);
  if (!normalized)
    throw new Error(`Not a valid Kenyan mobile number: ${input}`);
  return normalized;
}
