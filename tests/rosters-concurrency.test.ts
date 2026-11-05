import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { addException, listRoles, recordQualification, removeException, setRule, uncoveredSessions } from "../src/lib/rosters";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addSignOff } from "../src/lib/sign-offs";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A shift taken off the roster at the moment somebody books under it (ADR 0036).
 *
 * The booking asks the roster in its own transaction under the venue's roster lock (shared); a change to the roster takes it
 * whole. So the two never interleave between check and write: either the booking sees the shift gone and is refused, or it was
 * made first and the removal lists it as left without its supervisor. What can never happen is a booking in the diary, under a
 * shift that is gone, that nothing lists. Against PGlite the two interleave at every query; against a real Postgres server
 * (TEST_DATABASE_URL) they run on separate connections, which is where it would go wrong.
 */

let venueId: number;
let officerRole: number;
let annId: number;
const courts: number[] = [];
let n = 0;

const BOOKERS = 4;
const ROUNDS = 6;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Race Range", area: "Ipoh", address: "x", phone: "0355550304", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(venueId);
  for (let i = 0; i < BOOKERS; i++) {
    const c = await createCourt({ venueId, name: `Lane ${i + 1}`, sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!c.ok) throw new Error("court");
    courts.push(c.court.id);
  }
  const ann = await createAdmin({ name: "Ann Officer", email: "ann@race.my", password: "desk-password-1", venueId, role: "desk" });
  if (!ann.ok) throw new Error("staff");
  annId = ann.admin.id;
  officerRole = (await listRoles(venueId)).find((r) => r.key === "range_officer")!.id;
  await recordQualification(venueId, { personKind: "staff", personId: annId, qualification: "Range officer certificate" }, { id: null, name: "Test" });
  const rule = await setRule(venueId, { activity: "archery", roleId: officerRole, needed: 1 });
  if (!rule.ok) throw new Error("rule");
});

async function book(courtId: number, date: string) {
  const phone = `0155500${String(++n).padStart(3, "0")}`;
  await addSignOff({ venueId, sport: "archery", phone, name: "Racer", adminId: null });
  return createBooking({ courtId, date, hours: [10], name: "Racer", phone, by: "staff" });
}

describe("a shift removed while people book under it", () => {
  it("never leaves a booking under a gone shift that nothing lists, and refuses what sees it gone", async () => {
    let booked = 0;
    let refused = 0;
    for (let round = 0; round < ROUNDS; round++) {
      // An extra shift for that one date: its removal is the roster change racing the bookings.
      const date = addDays(todayISO(), 3 + round);
      const extra = await addException(venueId, { kind: "extra", personKind: "staff", personId: annId, date, roleId: officerRole, fromMin: 9 * 60, toMin: 17 * 60 });
      if (!extra.ok) throw new Error(JSON.stringify(extra));
      const [removal, ...bookings] = await Promise.all([removeException(venueId, extra.exception.id), ...courts.map((c) => book(c, date))]);
      expect(removal.ok).toBe(true);
      const listed = new Set((await uncoveredSessions([venueId])).map((u) => u.code));
      const removalSaw = new Set(removal.ok ? removal.affected.map((a) => a.code) : []);
      for (const b of bookings) {
        if (b.ok) {
          booked++;
          // Made first: the removal listed it, and the worklist still does.
          expect(listed.has(b.booking.code), `${b.booking.code} is in the diary under a shift that is gone, and nothing lists it`).toBe(true);
          // The removal itself says so, or the booking was committed after the removal's check and so the removal ran first: never.
          expect(removalSaw.has(b.booking.code)).toBe(true);
        } else {
          refused++;
          expect(b).toMatchObject({ code: "SV1_NO_SUPERVISOR" });
        }
      }
    }
    // Both orders happened or at least each answer was a consistent one.
    expect(booked + refused).toBe(ROUNDS * BOOKERS);
  });

  it("books everybody when the shift is not touched", async () => {
    const date = addDays(todayISO(), 20);
    const extra = await addException(venueId, { kind: "extra", personKind: "staff", personId: annId, date, roleId: officerRole, fromMin: 9 * 60, toMin: 17 * 60 });
    if (!extra.ok) throw new Error("extra");
    const results = await Promise.all(courts.map((c) => book(c, date)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await uncoveredSessions([venueId])).filter((u) => u.date === date)).toEqual([]);
  });
});
