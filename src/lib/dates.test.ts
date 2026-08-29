import { describe, expect, it, vi } from "vitest";

import { todayInBusinessZone } from "./dates";

/**
 * Kenya is UTC+3, so for the first three hours of each Kenyan day UTC still
 * reports yesterday. Read in UTC, a stay beginning today looks like it begins
 * tomorrow for those three hours — long enough for the "has this stay begun?"
 * guard to let a cancellation through on the arrival date itself.
 */
describe("todayInBusinessZone", () => {
  it.each([
    // 01:00 in Nairobi on the 1st is still 22:00 UTC on the previous day.
    ["2026-08-31T22:00:00Z", "2026-09-01"],
    ["2026-08-31T21:00:00Z", "2026-09-01"],
    // 23:59 UTC is already the next day in Nairobi.
    ["2026-08-31T23:59:00Z", "2026-09-01"],
    // Comfortably inside the same day either way.
    ["2026-09-01T09:00:00Z", "2026-09-01"],
    // 20:59 UTC is still the same Kenyan day.
    ["2026-08-31T20:59:00Z", "2026-08-31"],
  ])("at %s the Kenyan calendar day is %s", (instant, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));

    try {
      expect(todayInBusinessZone()).toBe(expected);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("disagrees with UTC exactly when Kenya has already turned over", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T22:00:00Z"));

    try {
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-31");
      expect(todayInBusinessZone()).toBe("2026-09-01");
    }
    finally {
      vi.useRealTimers();
    }
  });
});
