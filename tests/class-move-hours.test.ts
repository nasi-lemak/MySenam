import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { moveClasses } from "../src/lib/class-moves";
import { setHoursChange } from "../src/lib/dated-changes";
import { getDb } from "../src/lib/db";
import { closeVenueDay, createClassSessions, createCourt, createVenue, reopenVenueDay } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Moving a class onto a closed day or outside the operating hours stays refused (the owner's decision of 5 November 2026):
 * no override of any kind. An exceptional opening is made in the venue's own scheduling (reopening the day, hours from a
 * date), after which the class is moved normally; every other rule of a move still applies.
 */

let venueId: number;
let studioId: number;
let seq = 0;
const admin = { id: null as number | null, name: "Mona Mover" };
const day = (n: number) => addDays(todayISO(), n);
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = ok(await createVenue({ name: "Hours Studio", area: "Ipoh", address: "x", phone: "0355550501", openHour: 8, closeHour: 22 }));
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(venueId);
  studioId = ok(await createCourt({ venueId, name: "Studio 1", sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 })).court.id;
});

const aClass = async (offset = 5, hour = 18, courtId?: number) => {
  const court = courtId ?? ok(await createCourt({ venueId, name: `Studio ${++seq + 1}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 })).court.id;
  const made = ok(await createClassSessions({ courtId: court, name: `Hours ${++seq}`, instructor: "Aina", date: day(offset), startHour: hour, endHour: hour + 1, capacity: 5, price: 10 }));
  return made.classes[0];
};
const move = (id: number, date: string, startHour: number, extra: Record<string, unknown> = {}) =>
  moveClasses(admin, id, { date, start: startHour * 60, ...extra } as Parameters<typeof moveClasses>[2]);

describe("a class is not moved onto a closed day or outside the hours", () => {
  it("refuses a closed day and outside the usual hours, whoever asks and whatever the request carries", async () => {
    const session = await aClass();
    ok(await closeVenueDay(venueId, day(20), "Public holiday"));
    expect(await move(session.id, day(20), 18)).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    expect(await move(session.id, day(12), 6)).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    expect(await move(session.id, day(12), 22)).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    // No flag, reason or override in the request is read: the same refusals.
    for (const extra of [{ override: true }, { overrideHours: true, reason: "Special event" }, { force: true }]) {
      expect(await move(session.id, day(20), 18, extra)).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
      expect(await move(session.id, day(12), 6, extra)).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    }
    // Nothing moved.
    expect((await getDb().prepare("SELECT date, start_min FROM classes WHERE id = ?").get(session.id)) as { date: string; start_min: number }).toEqual({ date: day(5), start_min: 18 * 60 });
  });

  it("moves normally once the venue has made the opening in its own scheduling: a closed day reopened", async () => {
    const session = await aClass();
    ok(await closeVenueDay(venueId, day(21), "Cleaning"));
    expect(await move(session.id, day(21), 18)).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    expect((await reopenVenueDay(venueId, day(21))).ok).toBe(true);
    expect((await move(session.id, day(21), 18)).ok).toBe(true);
  });

  it("moves normally once the hours from a date take in the time; every other rule of a move still applies", async () => {
    const session = await aClass();
    const from = day(30);
    expect(await move(session.id, day(32), 6)).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    ok(await setHoursChange(venueId, { from, openMin: 5 * 60, closeMin: 22 * 60 }));
    // The earlier days are as they were; the new hours apply from the date.
    expect(await move(session.id, day(29), 6)).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    const moved = await move(session.id, day(32), 6);
    expect(moved.ok).toBe(true);
    // The rest of the rules hold in the new hours: another class on the same court and time is in the way.
    const courtOf = ((await getDb().prepare("SELECT court_id FROM classes WHERE id = ?").get(session.id)) as { court_id: number }).court_id;
    const other = await aClass(6, 18, courtOf);
    expect(await move(other.id, day(32), 6)).toMatchObject({ ok: false });
  });
});
