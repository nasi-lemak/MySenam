import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { updatePolicy } from "../src/lib/booking-policy";
import { importTide, saveRule } from "../src/lib/launch-windows";
import { region } from "../src/lib/region";
import { createBooking, createCourt, createVenue, getAvailability } from "../src/lib/store";
import { setVenueZone } from "../src/lib/zones";

/**
 * A venue where the clocks change, and a tide table in UTC (ADR 0037): the table's instants are read
 * as the venue's clock has them. No country MySenam is sold in changes its clocks; London is added to
 * this process's zones for the test only, as tests/clock-changes.test.ts does.
 */

const at = (h: number, m = 0) => h * 60 + m;
const zones = region().timeZones;
let venueId: number;
let courtId: number;
let n = 0;

beforeAll(async () => {
  zones.push("Europe/London");
  const made = await createVenue({ name: "Thames Hire", area: "x", address: "x", phone: "0312377778", openMin: at(6), closeMin: at(22) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  expect(await setVenueZone(venueId, "Europe/London")).toMatchObject({ ok: true });
  const court = await createCourt({ venueId, name: "Skiff", sport: "kayak", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
  expect(await updatePolicy({ venue: venueId }, { startEvery: 15, lengthStep: 15, minLength: 30, maxLength: 240, noticeMinutes: 0 })).toMatchObject({ ok: true });
});

afterAll(() => {
  zones.splice(zones.indexOf("Europe/London"), 1);
});
afterEach(() => vi.useRealTimers());

describe("windows where the clocks change", () => {
  it("reads a UTC table as the venue's clock had it: the same tide is an hour later on the day the clocks go forward", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    // A high tide at 12:00 UTC on both days, in UTC; the first is GMT (12:00 on the clock), the second BST (13:00).
    const csv = [
      "date,time,type,height_m",
      "2026-03-28,05:50,low,0.5",
      "2026-03-28,12:00,high,3.0",
      "2026-03-28,18:10,low,0.6",
      "2026-03-29,06:00,low,0.5",
      "2026-03-29,12:00,high,3.0",
      "2026-03-29,18:20,low,0.6",
    ].join("\n");
    expect(await importTide(venueId, { station: "Thames", csv, times: "utc" }, null)).toMatchObject({ ok: true, added: 6 });
    expect(await saveRule(venueId, { courtId, source: "tide", station: "Thames", tide: { rule: "event", eventKind: "high", eventMinutes: 60 } }, null)).toMatchObject({ ok: true });
    const windowsOf = async (date: string) => (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!.launch!.windows;
    expect(await windowsOf("2026-03-28")).toEqual([{ start: at(11), end: at(13) }]);
    // 29 March: the clocks went forward at 01:00, so 12:00 UTC is 13:00 on the clock.
    expect(await windowsOf("2026-03-29")).toEqual([{ start: at(12), end: at(14) }]);
    // Booked on the clock: 12:00 to 13:00 BST is inside, 11:00 to 12:00 is not.
    const phone = () => `0166660${String(++n).padStart(3, "0")}`;
    expect(await createBooking({ courtId, date: "2026-03-29", start: at(12), end: at(13), name: "Paddler", phone: phone() })).toMatchObject({ ok: true });
    expect(await createBooking({ courtId, date: "2026-03-29", start: at(10), end: at(11), name: "Paddler", phone: phone() })).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
  });

  it("refuses a CSV time the clocks skip or repeat rather than guess it, and takes it in UTC", async () => {
    const local = await importTide(venueId, { station: "Thames", csv: "date,time,type,height_m\n2026-03-29,01:30,high,3.1", times: "venue" }, null);
    expect(local).toMatchObject({ ok: false, errors: [{ line: 2, code: "clock" }] });
    expect(await importTide(venueId, { station: "Thames", csv: "date,time,type,height_m\n2026-03-29,01:30,high,3.1", times: "utc" }, null)).toMatchObject({ ok: true });
  });
});
