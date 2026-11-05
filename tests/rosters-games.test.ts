import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createResources } from "../src/lib/resources";
import { addShift, listRoles, saveRole, setRule, supervisorsOf } from "../src/lib/rosters";
import { addGames, createBooking, createVenue, findBookingByCode } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import { updatePolicy } from "../src/lib/booking-policy";

/**
 * A booking sold by the game grows when games are added (docs/features/booking.md#by-the-game-and-a-lane-given-on-arrival):
 * the longer session needs somebody qualified on shift for all of it, as a booking of that length would (ADR 0036).
 */

let venueId: number;
let lane: number;
const date = addDays(todayISO(), 5);

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Strike Range", area: "Subang", address: "1 Jalan Pin", phone: "0312345680", openMin: 0, closeMin: 24 * 60 });
  if (!v.ok) throw new Error(v.error);
  venueId = v.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const made = await createResources({ venueId, sport: "bowling", count: 1, offPeakRate: 30, peakRate: 30, capacity: 1, perPlayer: true, maxPlayers: 6 });
  if (!made.ok) throw new Error(made.error);
  lane = made.courts[0].id;
  expect((await updatePolicy({ venue: venueId, sport: "bowling" }, { gamePrice: 12 })).ok).toBe(true);
  const steward = await createAdmin({ name: "Sam Steward", email: "sam@strike.test", password: "a long enough password", venueId, role: "desk" });
  if (!steward.ok) throw new Error("staff");
  const role = (await listRoles(venueId)).find((r) => r.key === "instructor")!;
  await saveRole(venueId, { id: role.id, qualification: "" });
  // On shift from 10:00 to 10:55, on the day.
  const shift = await addShift(venueId, { roleId: role.id, personKind: "staff", personId: steward.admin.id, weekday: dayOfWeek(date), fromMin: 10 * 60, toMin: 10 * 60 + 55 });
  if (!shift.ok) throw new Error(JSON.stringify(shift));
  const rule = await setRule(venueId, { courtId: lane, roleId: role.id, needed: 1 });
  if (!rule.ok) throw new Error(JSON.stringify(rule));
});

describe("games added to a booking", () => {
  it("are asked of the roster for the longer session, and refused where the shift ends", async () => {
    const made = await createBooking({ courtId: lane, date, start: 10 * 60, games: 1, players: 1, name: "Bea Bowler", phone: "0177000001", by: "staff" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const end = made.booking.endMin;
    expect(end).toBeLessThanOrEqual(10 * 60 + 55);
    // Games are added until the session would run past the shift: the next is refused with the roster's code, and nothing changes.
    let added = 0;
    let last: Awaited<ReturnType<typeof addGames>> | null = null;
    for (let i = 0; i < 6; i++) {
      last = await addGames(made.booking.code, 1);
      if (!last.ok) break;
      added++;
    }
    expect(last).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    expect(added).toBeGreaterThan(0);
    const now = (await findBookingByCode(made.booking.code))!;
    expect(now.games).toBe(1 + added);
    expect(now.endMin).toBeLessThanOrEqual(10 * 60 + 55);
    // The supervisor is named for the whole longer session.
    const named = (await supervisorsOf("booking", [made.booking.id])).get(made.booking.id)!;
    expect(named).toHaveLength(1);
    expect(named[0].personName).toBe("Sam Steward");
  });
});
