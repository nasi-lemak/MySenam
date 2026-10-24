import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { instantOf } from "../src/lib/interval";
import { region } from "../src/lib/region";
import { createBooking, createCourt, createVenue, getAvailability } from "../src/lib/store";
import { clockProblem, crossesClockChange } from "../src/lib/time";
import { setVenueZone } from "../src/lib/zones";

/**
 * Where the clocks change, some wall-clock minutes never happen and others
 * happen twice (lib/time.ts). Worked out from the runtime's zone database on
 * real transition dates; a booking touching a change is not sold, by anybody.
 * No country MySenam is sold in changes its clocks: the venue below is put in
 * London by adding the zone to this process's country only.
 */

describe("a wall-clock minute where the clocks change", () => {
  it("is skipped going forward and repeated going back, on real transition dates", () => {
    // London: forward 01:00 → 02:00 on 29 March 2026, back 02:00 → 01:00 on 25 October 2026.
    expect(clockProblem("2026-03-29", 60, "Europe/London")).toBe("skipped");
    expect(clockProblem("2026-03-29", 90, "Europe/London")).toBe("skipped");
    expect(clockProblem("2026-03-29", 30, "Europe/London")).toBeNull();
    expect(clockProblem("2026-03-29", 120, "Europe/London")).toBeNull();
    expect(clockProblem("2026-10-25", 60, "Europe/London")).toBe("repeated");
    expect(clockProblem("2026-10-25", 90, "Europe/London")).toBe("repeated");
    expect(clockProblem("2026-10-25", 120, "Europe/London")).toBeNull();
    // New York: forward 02:00 → 03:00 on 8 March, back 02:00 → 01:00 on 1 November.
    expect(clockProblem("2026-03-08", 150, "America/New_York")).toBe("skipped");
    expect(clockProblem("2026-11-01", 90, "America/New_York")).toBe("repeated");
    // Sydney the other way round: forward on 4 October, back on 5 April.
    expect(clockProblem("2026-10-04", 150, "Australia/Sydney")).toBe("skipped");
    expect(clockProblem("2026-04-05", 150, "Australia/Sydney")).toBe("repeated");
    // A business day's minutes past midnight are the next morning's.
    expect(clockProblem("2026-03-28", 24 * 60 + 90, "Europe/London")).toBe("skipped");
    // Where MySenam is sold, never.
    expect(clockProblem("2026-03-29", 90, "Asia/Kuala_Lumpur")).toBeNull();
    expect(clockProblem("2026-10-25", 90, "Asia/Singapore")).toBeNull();
  });

  it("makes a span last more or less than it says only across the change, which is what is refused", () => {
    const real = (date: string, start: number, end: number, zone: string) => (instantOf(date, end, zone).getTime() - instantOf(date, start, zone).getTime()) / 60_000;
    expect(real("2026-03-29", 600, 660, "Europe/London")).toBe(60);
    // Three hours on the clock, two in fact.
    expect(real("2026-03-29", 0, 180, "Europe/London")).toBe(120);
    expect(crossesClockChange("2026-03-29", 0, 180, "Europe/London")).toBe(true);
    expect(crossesClockChange("2026-03-29", 600, 660, "Europe/London")).toBe(false);
    // Ending at a minute that happens twice, or running through the night the clocks go back.
    expect(crossesClockChange("2026-10-25", 0, 60, "Europe/London")).toBe(true);
    expect(crossesClockChange("2026-10-24", 22 * 60, 27 * 60, "Europe/London")).toBe(true);
    expect(crossesClockChange("2026-10-25", 180, 240, "Europe/London")).toBe(false);
    expect(crossesClockChange("2026-10-25", 0, 180, "Asia/Kuala_Lumpur")).toBe(false);
  });
});

describe("booking at a venue whose clocks change", () => {
  let venueId: number;
  let courtId: number;
  let n = 0;
  const phone = () => `0187770${String(++n).padStart(3, "0")}`;
  const zones = region().timeZones;

  beforeAll(async () => {
    zones.push("Europe/London");
    // Open from 18:00 until 04:00 the next morning, so the night the clocks change is inside its hours.
    const made = await createVenue({ name: "Night Courts", area: "x", address: "x", phone: "0312377777", openMin: 18 * 60, closeMin: 28 * 60 });
    if (!made.ok) throw new Error("venue");
    venueId = made.venue.id;
    expect(await setVenueZone(venueId, "Europe/London")).toMatchObject({ ok: true });
    const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!court.ok) throw new Error(court.error);
    courtId = court.court.id;
  });

  afterAll(() => {
    zones.splice(zones.indexOf("Europe/London"), 1);
  });

  afterEach(() => vi.useRealTimers());

  const book = (date: string, start: number, end: number, staff = false) =>
    createBooking({ courtId, date, start, end, name: "Night Player", phone: phone(), ...(staff ? { by: "staff" as const, staff: { override: true } } : {}) });

  it("the night the clocks go forward: offers no start touching it, refuses a booking across it, a manager's too, and books either side", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    const day = (await getAvailability(venueId, "2026-03-28")).find((d) => d.court.id === courtId)!;
    const starts = day.starts.map((s) => s.minute);
    // Midnight to 01:00 ends at a minute that never happens, and 01:00 itself never does.
    expect(starts).not.toContain(24 * 60);
    expect(starts).not.toContain(25 * 60);
    expect(starts).toContain(26 * 60);
    // 23:00 may run an hour, not into the change.
    expect(day.starts.find((s) => s.minute === 23 * 60)!.maxLength).toBe(60);

    expect(await book("2026-03-28", 24 * 60, 26 * 60)).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
    expect(await book("2026-03-28", 24 * 60, 26 * 60, true)).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
    const after = await book("2026-03-28", 26 * 60, 27 * 60);
    if (!after.ok) throw new Error(after.error);
    // An hour on the clock is an hour held.
    const held = (await getDb()
      .prepare("SELECT EXTRACT(EPOCH FROM upper(during) - lower(during))::int AS s FROM claims WHERE booking_id = ?")
      .get(after.booking.id)) as { s: number };
    expect(held.s).toBe(3600);
    expect((await book("2026-03-28", 22 * 60, 23 * 60)).ok).toBe(true);
  });

  it("the night the clocks go back: refuses the hour that happens twice, and books the hours around it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    expect(await book("2026-10-24", 25 * 60, 26 * 60)).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
    expect(await book("2026-10-24", 24 * 60, 25 * 60)).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
    expect((await book("2026-10-24", 26 * 60, 27 * 60)).ok).toBe(true);
    expect((await book("2026-10-24", 23 * 60, 24 * 60)).ok).toBe(true);
  });
});
