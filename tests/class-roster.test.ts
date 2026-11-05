import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { moveClasses } from "../src/lib/class-moves";
import { getDb } from "../src/lib/db";
import { saveCoach } from "../src/lib/coaching";
import { addShift, listRoles, recordQualification, setRule, type RosterRole } from "../src/lib/rosters";
import { createClassSessions, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A class and the roster (ADR 0036, ADR 0043): moving a class is asked who supervises it at its new time, as scheduling it is;
 * and a coach named to supervise another session then is not also taken to teach a class.
 */

let venueId: number;
let studioId: number;
let officer: RosterRole;
let seq = 0;
const admin = { id: null as number | null, name: "Mona Mover" };
const day = (n: number) => addDays(todayISO(), n);
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Roster Studio", area: "Ipoh", address: "x", phone: "0355550401", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(venueId);
  const studio = await createCourt({ venueId, name: "Studio 1", sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
  if (!studio.ok) throw new Error("court");
  studioId = studio.court.id;
  const staff = ok(await createAdmin({ name: "Ann Officer", email: "ann-cr@studio.my", password: "staff-password-1", venueId, role: "desk" }));
  officer = (await listRoles(venueId)).find((r) => r.key === "instructor")!;
  ok(await recordQualification(venueId, { personKind: "staff", personId: staff.admin.id, qualification: officer.qualification ?? "instructor certificate" }, { id: null, name: "Owner" }));
  // Ann is on shift 09:00 to 17:00 every day; the studio needs one instructor on shift.
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) ok(await addShift(venueId, { roleId: officer.id, personKind: "staff", personId: staff.admin.id, weekday, fromMin: 9 * 60, toMin: 17 * 60 }));
  ok(await setRule(venueId, { courtId: studioId, roleId: officer.id, needed: 1 }));
});

const schedule = (startHour: number, extra: Record<string, unknown> = {}) =>
  createClassSessions({ courtId: studioId, name: `Rostered ${++seq}`, instructor: "typed name", date: day(5), startHour, endHour: startHour + 1, capacity: 5, price: 10, ...extra } as Parameters<typeof createClassSessions>[0]);

describe("moving a class asks the roster", () => {
  it("refuses a new time nobody is rostered for, and says so; accepts one inside a shift, and names who supervises it there", async () => {
    const made = ok(await schedule(10));
    const id = made.classes[0].id;
    // Scheduling it outside the shift (it ends at 17:00) is refused too.
    expect((await schedule(17)).ok).toBe(false);
    const refused = await moveClasses(admin, id, { date: day(5), start: 17 * 60 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toMatch(/SV1_NO_SUPERVISOR/);
    // Nothing moved.
    expect((await getDb().prepare("SELECT start_min FROM classes WHERE id = ?").get(id)) as { start_min: number }).toEqual({ start_min: 10 * 60 });
    const moved = await moveClasses(admin, id, { date: day(5), start: 12 * 60 });
    expect(moved.ok).toBe(true);
    const supervisors = (await getDb().prepare("SELECT person_name FROM session_supervisors WHERE class_id = ? AND active").all(id)) as { person_name: string }[];
    expect(supervisors.map((s) => s.person_name)).toEqual(["Ann Officer"]);
  });
});

describe("a coach named to supervise is not also taken to teach a class", () => {
  it("is refused for an overlapping class, and free for another time", async () => {
    const coach = ok(await saveCoach(venueId, { name: "Coach Supervisor", sports: ["gym"], rate: 60, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 20 * 60 })) })).coach;
    // Another session of the venue, with this coach named its supervisor at 13:00 to 14:00.
    const other = ok(await schedule(13)).classes[0];
    const during = `["${day(5)}T13:00:00+08:00","${day(5)}T14:00:00+08:00")`;
    await getDb()
      .prepare(
        `INSERT INTO session_supervisors (venue_id, class_id, role_id, role_key, role_name, person_kind, person_id, person_name, how, during)
         VALUES (?, ?, ?, ?, ?, 'coach', ?, ?, 'rostered', ?::tstzrange)`
      )
      .run(venueId, other.id, officer.id, officer.key, officer.name, coach.id, coach.name, during);
    const clash = await schedule(13, { coachId: coach.id });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe("COACH_TAKEN");
    expect((await schedule(15, { coachId: coach.id })).ok).toBe(true);
  });
});
