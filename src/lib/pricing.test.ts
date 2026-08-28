import { describe, expect, it } from "vitest";

import { calculateBookingTotal, isWeekendNight, nightlyBreakdown, nightlyRate, nightsBetween } from "./pricing";

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

describe("isWeekendNight", () => {
  // A night is named by the date slept, so Friday and Saturday nights are the
  // weekend — arriving Friday and leaving Sunday is two weekend nights.
  it.each([
    ["2026-09-11", true, "Friday"],
    ["2026-09-12", true, "Saturday"],
    ["2026-09-13", false, "Sunday"],
    ["2026-09-10", false, "Thursday"],
    ["2026-09-14", false, "Monday"],
  ])("%s -> %s (%s)", (night, expected) => {
    expect(isWeekendNight(night)).toBe(expected);
  });
});

describe("nightlyRate", () => {
  const property = {
    pricePerNightCents: 800_000,
    cleaningFeeCents: 150_000,
    weekendPriceCents: 1_000_000,
  };

  it("uses the base rate midweek", () => {
    expect(nightlyRate(property, "2026-09-10")).toBe(800_000);
  });

  it("uses the weekend rate on a Friday night", () => {
    expect(nightlyRate(property, "2026-09-11")).toBe(1_000_000);
  });

  it("uses the base rate when no weekend rate is set", () => {
    expect(nightlyRate(
      { pricePerNightCents: 800_000, cleaningFeeCents: 0 },
      "2026-09-11",
    )).toBe(800_000);
  });

  it("treats a weekend rate of null as unset", () => {
    expect(nightlyRate(
      { ...property, weekendPriceCents: null },
      "2026-09-11",
    )).toBe(800_000);
  });

  // Precedence matters: a season priced for Christmas should not be quietly
  // overridden because the 25th happens to fall on a Friday.
  it("prefers a seasonal override to the weekend rate", () => {
    const overrides = [{
      startDate: "2026-09-11",
      endDate: "2026-09-13",
      pricePerNightCents: 1_500_000,
    }];
    expect(nightlyRate(property, "2026-09-11", overrides)).toBe(1_500_000);
  });

  it("applies an override to a midweek night too", () => {
    const overrides = [{
      startDate: "2026-09-07",
      endDate: "2026-09-11",
      pricePerNightCents: 1_500_000,
    }];
    expect(nightlyRate(property, "2026-09-08", overrides)).toBe(1_500_000);
  });

  it("treats an override as half-open — the end date is not covered", () => {
    const overrides = [{
      startDate: "2026-09-07",
      endDate: "2026-09-10",
      pricePerNightCents: 1_500_000,
    }];
    expect(nightlyRate(property, "2026-09-09", overrides)).toBe(1_500_000);
    expect(nightlyRate(property, "2026-09-10", overrides)).toBe(800_000);
  });

  it("ignores an override for other dates", () => {
    const overrides = [{
      startDate: "2026-12-20",
      endDate: "2027-01-05",
      pricePerNightCents: 2_000_000,
    }];
    expect(nightlyRate(property, "2026-09-10", overrides)).toBe(800_000);
  });
});

describe("calculateBookingTotal with seasonal rates", () => {
  const property = {
    pricePerNightCents: 800_000,
    cleaningFeeCents: 150_000,
    weekendPriceCents: 1_000_000,
  };

  it("charges weekend nights at the weekend rate", () => {
    // Thu 10th -> Sun 13th: Thu base, Fri + Sat weekend.
    const total = calculateBookingTotal(property, "2026-09-10", "2026-09-13");
    expect(total).toBe(800_000 + 1_000_000 + 1_000_000 + 150_000);
  });

  it("mixes overrides, weekend and base rates across one stay", () => {
    // Override covers Thu + Fri; Sat falls back to the weekend rate.
    const overrides = [{
      startDate: "2026-09-10",
      endDate: "2026-09-12",
      pricePerNightCents: 1_500_000,
    }];
    const total = calculateBookingTotal(property, "2026-09-10", "2026-09-13", overrides);
    expect(total).toBe(1_500_000 + 1_500_000 + 1_000_000 + 150_000);
  });

  it("charges the cleaning fee once regardless of rate mix", () => {
    const nights = nightlyBreakdown(property, "2026-09-10", "2026-09-14");
    const total = calculateBookingTotal(property, "2026-09-10", "2026-09-14");
    expect(total - nights.reduce((s, n) => s + n.rateCents, 0)).toBe(150_000);
  });

  it("still yields whole shillings with every rate type in play", () => {
    const overrides = [{
      startDate: "2026-09-10",
      endDate: "2026-09-12",
      pricePerNightCents: 1_500_000,
    }];
    expect(calculateBookingTotal(property, "2026-09-08", "2026-09-16", overrides) % 100)
      .toBe(0);
  });

  it("matches the old behaviour when nothing special applies", () => {
    const plain = { pricePerNightCents: 850_000, cleaningFeeCents: 150_000 };
    // Mon -> Thu, no weekend rate, no overrides.
    expect(calculateBookingTotal(plain, "2026-09-14", "2026-09-17"))
      .toBe(3 * 850_000 + 150_000);
  });
});

describe("nightlyBreakdown", () => {
  const property = {
    pricePerNightCents: 800_000,
    cleaningFeeCents: 150_000,
    weekendPriceCents: 1_000_000,
  };

  it("names every night and why its rate applied", () => {
    const overrides = [{
      startDate: "2026-09-10",
      endDate: "2026-09-11",
      pricePerNightCents: 1_500_000,
    }];
    const nights = nightlyBreakdown(property, "2026-09-10", "2026-09-13", overrides);

    expect(nights).toEqual([
      { night: "2026-09-10", rateCents: 1_500_000, reason: "override" },
      { night: "2026-09-11", rateCents: 1_000_000, reason: "weekend" },
      { night: "2026-09-12", rateCents: 1_000_000, reason: "weekend" },
    ]);
  });

  it("reports base for every night when nothing special applies", () => {
    const plain = { pricePerNightCents: 800_000, cleaningFeeCents: 0 };
    const nights = nightlyBreakdown(plain, "2026-09-14", "2026-09-16");
    expect(nights.map(n => n.reason)).toEqual(["base", "base"]);
  });

  it("throws when check-out is not after check-in", () => {
    expect(() => nightlyBreakdown(property, "2026-09-10", "2026-09-10"))
      .toThrow(/after check-in/i);
  });
});
