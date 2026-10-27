import { afterEach, describe, expect, it, vi } from "vitest";
import { currentHour, isPastSlot, todayISO } from "../src/lib/time";

/**
 * The date formatters are built once and reused, because building one per call
 * made a search across every venue take seconds. A reused formatter must still
 * read the clock each time it is asked: these move the clock across Malaysian
 * midnight and expect the answers to follow.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("Malaysia time follows the clock", () => {
  it("rolls the date and hour over at midnight in Kuala Lumpur, not UTC", () => {
    vi.useFakeTimers();

    // 23:59 in Kuala Lumpur, 15:59 UTC.
    vi.setSystemTime(new Date("2026-03-01T15:59:00Z"));
    expect(todayISO()).toBe("2026-03-01");
    expect(currentHour()).toBe(23);

    // One minute later it is tomorrow there, still today in UTC.
    vi.setSystemTime(new Date("2026-03-01T16:00:00Z"));
    expect(todayISO()).toBe("2026-03-02");
    expect(currentHour()).toBe(0);
  });

  it("treats a slot as past once its hour has begun", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T02:30:00Z")); // 10:30 in Kuala Lumpur

    expect(isPastSlot("2026-03-02", 10)).toBe(true);
    expect(isPastSlot("2026-03-02", 11)).toBe(false);
    expect(isPastSlot("2026-03-01", 22)).toBe(true);
    expect(isPastSlot("2026-03-03", 8)).toBe(false);
  });
});

describe("the date of a stored moment where the install is (receipts, invoices, reviews)", () => {
  it("is the install's date, not the UTC one, for an ISO time and for the database's UTC text", async () => {
    const { localDateOf } = await import("../src/lib/time");
    // 01:00 on 1 June in Kuala Lumpur is still 31 May in UTC.
    expect(localDateOf("2026-05-31T17:00:00Z", "Asia/Kuala_Lumpur")).toBe("2026-06-01");
    expect(localDateOf("2026-05-31 17:00:00", "Asia/Kuala_Lumpur")).toBe("2026-06-01");
    expect(localDateOf("2026-05-31T15:59:00Z", "Asia/Kuala_Lumpur")).toBe("2026-05-31");
  });
});
