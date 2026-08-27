import { describe, expect, it } from "vitest";

import { calculateBookingTotal, nightsBetween } from "./pricing";

describe("nightsBetween", () => {
  it.each([
    ["2026-09-10", "2026-09-11", 1],
    ["2026-09-10", "2026-09-15", 5],
    ["2026-09-28", "2026-10-02", 4], // across a month boundary
    ["2026-12-30", "2027-01-02", 3], // across a year boundary
    ["2028-02-27", "2028-03-01", 3], // across a leap day
  ])("counts %s -> %s as %i nights", (checkIn, checkOut, expected) => {
    expect(nightsBetween(checkIn, checkOut)).toBe(expected);
  });

  it("returns 0 for the same day", () => {
    expect(nightsBetween("2026-09-10", "2026-09-10")).toBe(0);
  });

  it("returns a negative count when reversed", () => {
    expect(nightsBetween("2026-09-15", "2026-09-10")).toBe(-5);
  });
});

describe("calculateBookingTotal", () => {
  const property = {
    pricePerNightCents: 850_000, // KES 8,500
    cleaningFeeCents: 150_000, // KES 1,500
  };

  it("multiplies nights by nightly rate and adds the cleaning fee once", () => {
    // 5 nights x 8,500 = 42,500 + 1,500 = KES 44,000
    expect(calculateBookingTotal(property, "2026-09-10", "2026-09-15"))
      .toBe(4_400_000);
  });

  it("charges the cleaning fee once on a single-night stay", () => {
    expect(calculateBookingTotal(property, "2026-09-10", "2026-09-11"))
      .toBe(1_000_000);
  });

  it("handles a zero cleaning fee", () => {
    expect(calculateBookingTotal(
      { pricePerNightCents: 500_000, cleaningFeeCents: 0 },
      "2026-09-10",
      "2026-09-13",
    )).toBe(1_500_000);
  });

  it("always yields a whole number of shillings when inputs are", () => {
    const total = calculateBookingTotal(property, "2026-09-10", "2026-09-17");
    expect(total % 100).toBe(0);
  });

  it("throws when check-out is not after check-in", () => {
    expect(() => calculateBookingTotal(property, "2026-09-10", "2026-09-10"))
      .toThrow(/after check-in/i);
    expect(() => calculateBookingTotal(property, "2026-09-15", "2026-09-10"))
      .toThrow(/after check-in/i);
  });
});
