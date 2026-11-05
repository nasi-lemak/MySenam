import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { attachCoach, coachById, saveCoach } from "../src/lib/coaching";
import { addSignOff } from "../src/lib/sign-offs";
import { getDb } from "../src/lib/db";
import {
  addException,
  addShift,
  coverSession,
  listRoles,
  overrideSession,
  recordQualification,
  removeException,
  removeRule,
  removeShift,
  rolesOnBookings,
  rosterFlags,
  saveRole,
  setRule,
  supervisorsOf,
  supply,
  uncoveredSessions,
  undoDecision,
  unmetNeeds,
  type RosterRole,
} from "../src/lib/rosters";
import {
  createBooking,
  createBookingSeries,
  createClassSessions,
  createCourt,
  createVenue,
  getAdminSlots,
  getAvailability,
  getBookingById,
  joinSlotWaitlist,
  moveBooking,
  moveTargetsFor,
  quoteFor,
  rescheduleBooking,
  listBookingsForDate,
} from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * Who supervises a session (ADR 0036): rosters, qualifications, rules, and the one booking path that asks them.
 * A venue rosters its staff and coaches by role; an activity that needs a range officer is bookable only where enough
 * qualified people are on shift for all of it.
 */

let venueId: number;
let archery: number;
let archery2: number;
let plain: number;
let roleOfficer: RosterRole;
let roleGuard: RosterRole;
let ann: { kind: "staff"; id: number };
let ben: { kind: "staff"; id: number };
let cara: { kind: "staff"; id: number };
let n = 0;
const phone = () => `0177700${String(++n).padStart(3, "0")}`;
/** A number the venue has signed off for archery (a range briefing), so the sign-off rule is out of the way. */
const signedPhone = async () => {
  const p = phone();
  const done = await addSignOff({ venueId, sport: "archery", phone: p, name: "Aziz Archer", adminId: null });
  if (!done.ok) throw new Error(done.error);
  return p;
};
const by = { id: null, name: "Test manager" };

/** The first `weekday` at least `days` ahead. */
function ahead(weekday: number, days: number): string {
  let d = addDays(todayISO(), days);
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return d;
}

const book = async (courtId: number, date: string, hours: number[], extra: object = {}) =>
  createBooking({ courtId, date, hours, name: "Aziz Archer", phone: await signedPhone(), by: "staff", ...extra });

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Range Hall", area: "Ipoh", address: "x", phone: "0355550301", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(venueId);
  const a = await createCourt({ venueId, name: "Lane 1", sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1 });
  const a2 = await createCourt({ venueId, name: "Lane 2", sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1 });
  const p = await createCourt({ venueId, name: "Court 9", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!a.ok || !a2.ok || !p.ok) throw new Error("court");
  archery = a.court.id;
  archery2 = a2.court.id;
  plain = p.court.id;
  const staff = async (name: string, email: string) => {
    const r = await createAdmin({ name, email, password: "staff-password-1", venueId, role: "desk" });
    if (!r.ok) throw new Error("staff");
    return { kind: "staff" as const, id: r.admin.id };
  };
  ann = await staff("Ann Officer", "ann@range.my");
  ben = await staff("Ben Night", "ben@range.my");
  cara = await staff("Cara Cover", "cara@range.my");
  const roles = await listRoles(venueId);
  roleOfficer = roles.find((r) => r.key === "range_officer")!;
  roleGuard = roles.find((r) => r.key === "lifeguard")!;
  // Everybody holds the certificate unless a test says otherwise (no end day).
  for (const p of [ann, ben, cara]) ok(await recordQualification(venueId, { personKind: p.kind, personId: p.id, qualification: "range officer certificate" }, by));
  // Ann: Monday to Friday 09:00-17:00 as range officer.
  for (const weekday of [1, 2, 3, 4, 5]) ok(await addShift(venueId, { roleId: roleOfficer.id, personKind: "staff", personId: ann.id, weekday, fromMin: 9 * 60, toMin: 17 * 60 }));
  // The lanes of the range need one range officer; the badminton court nothing.
  ok(await setRule(venueId, { courtId: archery, roleId: roleOfficer.id, needed: 1 }));
  ok(await setRule(venueId, { activity: "archery", roleId: roleOfficer.id, needed: 1 }));
});

describe("roles are data", () => {
  it("starts every venue with the three starters, tied to a qualification the venue may change", async () => {
    const roles = await listRoles(venueId);
    expect(roles.filter((r) => r.builtin).map((r) => r.key)).toEqual(["range_officer", "lifeguard", "instructor"]);
    expect(roleOfficer.qualification).toBe("Range officer certificate");
  });

  it("takes a role of the venue's own, and refuses turning off a role that rules still ask for", async () => {
    const custom = ok(await saveRole(venueId, { name: "Pool attendant", qualification: "" }));
    expect(custom.role.builtin).toBe(false);
    expect(custom.role.qualification).toBeNull();
    const off = await saveRole(venueId, { id: roleOfficer.id, active: false });
    expect(off.ok).toBe(false);
    // Another venue's role is not here.
    expect((await saveRole(venueId, { id: 999999, name: "x" })).ok).toBe(false);
  });
});

describe("the roster's maths", () => {
  it("counts the qualified people on shift for the whole of a session", async () => {
    const tue = ahead(2, 10);
    const zone = "Asia/Kuala_Lumpur";
    const need = async (start: number, end: number) => unmetNeeds({ venueId, courtId: archery, sport: "archery", date: tue, span: { start, end }, zone });
    expect(await need(10 * 60, 11 * 60)).toEqual([]);
    expect(await need(9 * 60, 17 * 60)).toEqual([]);
    // Shut an hour after Ann's shift ends: the gap is exactly that hour, in the day's minutes.
    const late = await need(16 * 60, 18 * 60);
    expect(late).toHaveLength(1);
    expect(late[0].gaps).toEqual([{ start: 17 * 60, end: 18 * 60 }]);
    expect(late[0].need.roleName).toBe("Range officer");
    // The weekend has nobody.
    const sat = ahead(6, 10);
    expect((await unmetNeeds({ venueId, courtId: archery, sport: "archery", date: sat, span: { start: 600, end: 660 }, zone }))[0].gaps).toEqual([{ start: 600, end: 660 }]);
  });

  it("needs n people at once, not one after another", async () => {
    // Two on at once on Wednesday 12-14 only: asking for two is met there and nowhere else.
    ok(await addShift(venueId, { roleId: roleOfficer.id, personKind: "staff", personId: cara.id, weekday: 3, fromMin: 12 * 60, toMin: 14 * 60 }));
    const wed = ahead(3, 10);
    const two = [{ roleId: roleOfficer.id, roleKey: "range_officer", roleName: "Range officer", needed: 2 }];
    const asked = (start: number, end: number) => unmetNeeds({ venueId, courtId: archery, sport: "archery", date: wed, span: { start, end }, zone: "Asia/Kuala_Lumpur", needs: two });
    expect(await asked(12 * 60, 14 * 60)).toEqual([]);
    expect((await asked(11 * 60, 14 * 60))[0].gaps).toEqual([{ start: 11 * 60, end: 12 * 60 }]);
    const row = (await getDb().prepare("SELECT id FROM roster_shifts WHERE person_id = ? AND weekday = 3").get(cara.id)) as { id: number };
    ok(await removeShift(venueId, row.id));
  });

  it("follows a shift past midnight, from the day it starts on", async () => {
    // Ben: Friday 22:00 to 06:00 (1320 to 1800).
    const shift = ok(await addShift(venueId, { roleId: roleOfficer.id, personKind: "staff", personId: ben.id, weekday: 5, fromMin: 22 * 60, toMin: 30 * 60 }));
    const fri = ahead(5, 10);
    const zone = "Asia/Kuala_Lumpur";
    const asked = (date: string, start: number, end: number) => unmetNeeds({ venueId, courtId: archery, sport: "archery", date, span: { start, end }, zone });
    // 23:00 to 02:00 the next morning is Friday's business-day minutes 1380-1560: all Ben's.
    expect(await asked(fri, 23 * 60, 26 * 60)).toEqual([]);
    // Saturday's own 01:00 is minute 60 of Saturday's day, the same moment: Ben covers it there too.
    expect(await asked(addDays(fri, 1), 60, 120)).toEqual([]);
    // After 06:00 Saturday nobody is on.
    expect((await asked(addDays(fri, 1), 6 * 60, 7 * 60))[0].gaps).toEqual([{ start: 6 * 60, end: 7 * 60 }]);
    // Thursday night he is not rostered.
    expect((await asked(addDays(fri, -1), 23 * 60, 24 * 60))[0].gaps).toHaveLength(1);
    ok(await removeShift(venueId, shift.shift.id));
  });

  it("is DST-safe: a night shift across a change of the clocks is as long as the night was", async () => {
    // The booking engine refuses zones with daylight saving, but the maths takes any zone: the shift is a wall clock.
    const night = ok(await addShift(venueId, { roleId: roleOfficer.id, personKind: "staff", personId: ben.id, weekday: 0, fromMin: 22 * 60, toMin: 30 * 60 }));
    // 28 March 2027, Europe/London: the clocks go forward at 01:00, so Sunday 22:00 to Monday 06:00 is 8 hours; the night before (Saturday 27th) is Saturday 22:00 to Sunday 06:00 = 7 hours.
    const window = { from: Date.UTC(2027, 2, 27, 0, 0), to: Date.UTC(2027, 2, 30, 0, 0) };
    const providers = await supply(venueId, "Europe/London", window);
    const mine = providers.filter((p) => p.person.id === ben.id && p.roleId === roleOfficer.id);
    const hours = mine.flatMap((p) => p.intervals).map((i) => (i.to - i.from) / 3_600_000);
    // The Saturday-night shift is not Ben's (Sunday only); Sunday night 28th to Monday 29th has no change inside it.
    expect(hours).toEqual([8]);
    // The same weekday on the night the clocks changed: move the pattern to Saturday.
    await getDb().prepare("UPDATE roster_shifts SET weekday = 6 WHERE id = ?").run(night.shift.id);
    const sat = (await supply(venueId, "Europe/London", window)).filter((p) => p.person.id === ben.id && p.roleId === roleOfficer.id);
    expect(sat.flatMap((p) => p.intervals).map((i) => (i.to - i.from) / 3_600_000)).toEqual([7]);
    ok(await removeShift(venueId, night.shift.id));
  });

  it("takes leave from the time it names, and the whole day when it names none", async () => {
    const mon = ahead(1, 14);
    const zone = "Asia/Kuala_Lumpur";
    const asked = (start: number, end: number) => unmetNeeds({ venueId, courtId: archery, sport: "archery", date: mon, span: { start, end }, zone });
    const afternoon = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: mon, fromMin: 13 * 60, toMin: 1440 }));
    expect(await asked(10 * 60, 11 * 60)).toEqual([]);
    expect((await asked(13 * 60, 14 * 60))[0].gaps).toEqual([{ start: 13 * 60, end: 14 * 60 }]);
    ok(await removeException(venueId, afternoon.exception.id));
    const day = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: mon }));
    expect((await asked(10 * 60, 11 * 60))[0].gaps).toHaveLength(1);
    // An extra shift for Cara the same day puts somebody on again.
    const extra = ok(await addException(venueId, { kind: "extra", personKind: "staff", personId: cara.id, date: mon, roleId: roleOfficer.id, fromMin: 9 * 60, toMin: 12 * 60 }));
    expect(await asked(10 * 60, 11 * 60)).toEqual([]);
    expect((await asked(11 * 60, 13 * 60))[0].gaps).toEqual([{ start: 12 * 60, end: 13 * 60 }]);
    ok(await removeException(venueId, extra.exception.id));
    ok(await removeException(venueId, day.exception.id));
  });

  it("respects a qualification's last day: on shift until the end of it, never silently valid after", async () => {
    // Cara: Tuesdays 09:00-17:00, certificate good to a Tuesday two weeks on.
    const shift = ok(await addShift(venueId, { roleId: roleOfficer.id, personKind: "staff", personId: cara.id, weekday: 2, fromMin: 9 * 60, toMin: 17 * 60 }));
    const lastTue = ahead(2, 14);
    // Ann also works Tuesdays: take her off for the Tuesday after, so only Cara's certificate decides.
    const after = addDays(lastTue, 7);
    const annLeave = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: lastTue }));
    const annLeave2 = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: after }));
    // The certificate recorded for her above has no last day: replace it with one ending on lastTue.
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE person_id = ?").run(cara.id);
    const q = ok(await recordQualification(venueId, { personKind: "staff", personId: cara.id, qualification: "Range Officer Certificate", expiresOn: lastTue }, by));
    const asked = (date: string) => unmetNeeds({ venueId, courtId: archery, sport: "archery", date, span: { start: 10 * 60, end: 11 * 60 }, zone: "Asia/Kuala_Lumpur" });
    expect(await asked(lastTue)).toEqual([]);
    expect(await asked(after)).toHaveLength(1);
    // The roster says why: a weekly shift outlives the certificate.
    const flags = await rosterFlags(venueId);
    expect(flags).toContainEqual(expect.objectContaining({ kind: "expires", personId: cara.id, expiresOn: lastTue, shiftId: shift.shift.id }));
    // Somebody with none recorded at all is on shift but counts for nothing, and is flagged.
    const none = ok(await saveRole(venueId, { name: "Marshal", qualification: "Marshal badge" }));
    const marshal = ok(await addShift(venueId, { roleId: none.role.id, personKind: "staff", personId: ben.id, weekday: 4, fromMin: 9 * 60, toMin: 12 * 60 }));
    expect(await rosterFlags(venueId)).toContainEqual(expect.objectContaining({ kind: "no_qualification", personId: ben.id, shiftId: marshal.shift.id }));
    for (const id of [annLeave.exception.id, annLeave2.exception.id]) ok(await removeException(venueId, id));
    ok(await removeShift(venueId, shift.shift.id));
    ok(await removeShift(venueId, marshal.shift.id));
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE id = ?").run(q.qualification.id);
    ok(await recordQualification(venueId, { personKind: "staff", personId: cara.id, qualification: "range officer certificate" }, by));
  });

  it("a role with no qualification counts everyone rostered", async () => {
    const open = ok(await saveRole(venueId, { name: "Door steward", qualification: "" }));
    const shift = ok(await addShift(venueId, { roleId: open.role.id, personKind: "staff", personId: ben.id, weekday: 1, fromMin: 9 * 60, toMin: 10 * 60 }));
    const mon = ahead(1, 20);
    const needs = [{ roleId: open.role.id, roleKey: open.role.key, roleName: "Door steward", needed: 1 }];
    expect(await unmetNeeds({ venueId, courtId: archery, sport: "archery", date: mon, span: { start: 540, end: 600 }, zone: "Asia/Kuala_Lumpur", needs })).toEqual([]);
    ok(await removeShift(venueId, shift.shift.id));
  });
});

describe("the one booking path", () => {
  it("books where a qualified person is on shift, and names who", async () => {
    const tue = ahead(2, 12);
    const made = ok(await book(archery, tue, [10]));
    const named = (await supervisorsOf("booking", [made.booking.id])).get(made.booking.id)!;
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ personName: "Ann Officer", roleKey: "range_officer", how: "rostered" });
    // The activity's other rule applies too (by activity, not only the lane): lane 2 asks the same.
    expect(ok(await book(archery2, tue, [11])).booking.id).toBeGreaterThan(0);
  });

  it("refuses an hour nobody is rostered for, with a code and words, on lane or activity", async () => {
    const tue = ahead(2, 12);
    const refused = await book(archery, tue, [18]);
    expect(refused).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR", vars: { role: "Range officer", n: 1 } });
    expect((refused as { error: string }).error).toMatch(/Range officer/);
    // Partly covered is refused: 16:00-18:00 runs an hour past Ann's shift.
    expect(await book(archery, tue, [16, 17])).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    // Another court needs nobody.
    expect((await book(plain, tue, [18])).ok).toBe(true);
    // A manager's override of the court's booking rules goes past none of it.
    expect(await book(archery, tue, [19], { staff: { override: true } })).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
  });

  it("is asked at the counter and through the venue API key alike", async () => {
    const sat = ahead(6, 12);
    for (const channel of ["staff", "api"] as const)
      expect(await createBooking({ courtId: archery, date: sat, hours: [10], name: "Online Ola", phone: await signedPhone(), by: channel })).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
  });

  it("is asked of a customer booking online too", async () => {
    const court = await createCourt({ venueId, name: "Court 13", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!court.ok) throw new Error("court");
    // Nobody is rostered as a lifeguard, so a court that asks for one cannot be booked by anybody.
    ok(await setRule(venueId, { courtId: court.court.id, roleId: roleGuard.id, needed: 1 }));
    expect(await createBooking({ courtId: court.court.id, date: ahead(2, 12), hours: [10], name: "Online Ola", phone: phone(), by: "customer" })).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR", vars: { role: "Lifeguard" } });
  });

  it("is asked of a quote too, so the price is never shown for an hour that cannot be booked", async () => {
    const tue = ahead(2, 12);
    expect(await quoteFor({ courtId: archery, date: tue, hours: [10] })).toMatchObject({ ok: true, allowed: true });
    expect(await quoteFor({ courtId: archery, date: tue, hours: [18] })).toMatchObject({ ok: true, allowed: false, refusal: { code: "SV1_NO_SUPERVISOR" } });
  });

  it("is asked of the waiting list: nobody queues for time that could not be booked", async () => {
    const tue = ahead(2, 12);
    // 10:00 is held and covered: the queue takes them. 18:00 has nobody rostered: the offer could never be booked.
    const held = await joinSlotWaitlist({ courtId: archery, date: tue, start: 10 * 60, end: 11 * 60, name: "Cy Queue", phone: await signedPhone(), madeBy: { channel: "staff", adminId: ann.id, name: "Ann Officer" } });
    expect(held, JSON.stringify(held)).toMatchObject({ ok: true });
    expect(await joinSlotWaitlist({ courtId: archery, date: tue, start: 18 * 60, end: 19 * 60, name: "Cy Queue", phone: await signedPhone(), madeBy: { channel: "staff", adminId: ann.id, name: "Ann Officer" } })).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
  });

  it("checks each week of a series: skipped and named when asked to, otherwise the whole series is refused", async () => {
    const start = ahead(2, 30);
    // Leave on the second Tuesday.
    const second = addDays(start, 7);
    const leave = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: second }));
    const skipping = ok(await createBookingSeries({ courtId: archery, date: start, hours: [10], weeks: 3, name: "Series Sam", phone: await signedPhone(), by: "staff", skipConflicts: true }));
    expect(skipping.bookings).toHaveLength(2);
    expect(skipping.skipped).toEqual([{ date: second, reason: "no Range officer rostered" }]);
    const whole = await createBookingSeries({ courtId: archery2, date: start, hours: [10], weeks: 3, name: "Series Sam", phone: await signedPhone(), by: "staff" });
    expect(whole.ok).toBe(false);
    expect((whole as { error: string }).error).toContain(second);
    expect((whole as { error: string }).error).toContain("no Range officer rostered");
    ok(await removeException(venueId, leave.exception.id));
  });

  it("says so when every week of a series is refused for want of a supervisor", async () => {
    const sat = ahead(6, 40);
    const all = await createBookingSeries({ courtId: archery, date: sat, hours: [10], weeks: 2, name: "Series Sam", phone: await signedPhone(), by: "staff", skipConflicts: true });
    expect(all).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
  });

  it("is asked when a booking is moved to another time: refused at an uncovered hour, previewed with the reason, kept as it was", async () => {
    const wed = ahead(3, 16);
    const made = ok(await book(archery, wed, [10])).booking;
    const refused = await rescheduleBooking(made.code, { date: wed, startHour: 18 }, "staff");
    expect(refused).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    const preview = await rescheduleBooking(made.code, { date: wed, startHour: 18, preview: true }, "staff");
    expect(preview).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    expect((await getBookingById(made.id))!.startMin).toBe(10 * 60);
    // To a covered hour: it moves, and the supervisor is named again for the new time; the old record stays as history.
    const moved = await rescheduleBooking(made.code, { date: wed, startHour: 14 }, "staff");
    expect(moved.ok).toBe(true);
    const rows = (await getDb().prepare("SELECT active, how FROM session_supervisors WHERE booking_id = ? ORDER BY id").all(made.id)) as { active: boolean; how: string }[];
    expect(rows.map((r) => r.active)).toEqual([false, true]);
  });

  it("is asked when a booking is moved to another court", async () => {
    const tue = ahead(2, 16);
    const made = ok(await book(archery, tue, [10])).booking;
    // A lane that also needs a lifeguard: nobody is rostered as one.
    const lane3 = await createCourt({ venueId, name: "Lane 3", sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!lane3.ok) throw new Error("court");
    ok(await setRule(venueId, { courtId: lane3.court.id, roleId: roleGuard.id, needed: 1 }));
    const refused = await moveBooking(made.code, lane3.court.id);
    expect(refused).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR", vars: { role: "Lifeguard" } });
    expect((await getBookingById(made.id))!.courtId).toBe(archery);
    // Lane 2 asks only the range officer, who is on.
    expect((await moveBooking(made.code, archery2)).ok).toBe(true);
    expect((await getBookingById(made.id))!.courtId).toBe(archery2);
  });

  it("is asked of a class session: refused at an uncovered hour, named when made", async () => {
    const fri = ahead(5, 18);
    const bad = await createClassSessions({ courtId: archery, name: "Evening archery", instructor: "Ali", date: fri, start: 19 * 60, end: 20 * 60, capacity: 1, price: 10 });
    expect(bad).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    const term = await createClassSessions({ courtId: archery, name: "Evening archery", instructor: "Ali", date: fri, start: 19 * 60, end: 20 * 60, capacity: 1, price: 10, weeks: 2 });
    expect(term).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR_ON", vars: { date: fri } });
    const good = ok(await createClassSessions({ courtId: archery, name: "Morning archery", instructor: "Ali", date: fri, start: 10 * 60, end: 11 * 60, capacity: 1, price: 10 }));
    const named = (await supervisorsOf("class", [good.classes[0].id])).get(good.classes[0].id)!;
    expect(named[0].personName).toBe("Ann Officer");
  });

  it("shows the grid and the starts only where somebody is rostered", async () => {
    const tue = ahead(2, 22);
    const [lane] = (await getAvailability(venueId, tue, "archery")).filter((c) => c.court.id === archery);
    const at = (minute: number) => lane.slots.find((s) => s.minute === minute)!;
    expect(at(10 * 60)).toMatchObject({ available: true });
    expect(at(10 * 60).unsupervised).toBeUndefined();
    expect(at(18 * 60)).toMatchObject({ available: false, unsupervised: true });
    expect(lane.starts.some((s) => s.minute === 18 * 60)).toBe(false);
    // A start at 16:00 can run to 17:00 and no longer.
    expect(lane.starts.find((s) => s.minute === 16 * 60)!.maxLength).toBe(60);
    // The badminton court shows nothing of it.
    const [court] = (await getAvailability(venueId, tue, "badminton")).filter((c) => c.court.id === plain);
    expect(court.slots.some((s) => s.unsupervised)).toBe(false);
  });

  it("keeps a booking's moves to courts that can take it", async () => {
    const tue = ahead(2, 22);
    const made = ok(await book(archery, tue, [10])).booking;
    expect((await moveTargetsFor(made.code)).map((c) => c.id)).toContain(archery2);
    const late = ok(await book(plain, tue, [20])).booking;
    expect(await moveTargetsFor(late.code)).toEqual([]);
  });

  it("shows staff who supervises a booking, and a customer only the role", async () => {
    const tue = ahead(2, 12);
    const day = (await listBookingsForDate(tue, venueId)).filter((b) => b.courtId === archery);
    const mine = day.find((b) => b.supervisors?.length);
    expect(mine!.supervisors![0]).toMatchObject({ role: "Range officer", person: "Ann Officer", how: "rostered" });
    const roles = await rolesOnBookings([mine!.id]);
    expect(roles.get(mine!.id)).toEqual([{ key: "range_officer", name: "Range officer" }]);
    expect(JSON.stringify([...roles])).not.toContain("Ann");
    const slots = (await getAdminSlots(venueId, tue)).find((c) => c.court.id === archery)!;
    expect(slots.entries.find((e) => e.bookingCode === mine!.code)!.supervisors![0].person).toBe("Ann Officer");
  });
});

describe("absence after bookings exist", () => {
  it("never cancels: lists the sessions, lets a manager cover or let one stand with a reason, and undo", async () => {
    const thu = ahead(4, 24);
    const made = ok(await book(archery, thu, [11])).booking;
    const shiftRow = (await getDb()
      .prepare("SELECT id FROM roster_shifts WHERE person_id = ? AND weekday = 4 AND role_id = ?")
      .get(ann.id, roleOfficer.id)) as { id: number };
    const removal = ok(await removeShift(venueId, shiftRow.id));
    // The booking stands and the removal said which sessions it left without a supervisor.
    expect((await getBookingById(made.id))!.status).toBe("confirmed");
    expect(removal.affected.map((a) => a.code)).toContain(made.code);
    const listed = (await uncoveredSessions([venueId])).find((u) => u.code === made.code)!;
    expect(listed.roles[0]).toMatchObject({ roleName: "Range officer", needed: 1, gaps: [{ start: 11 * 60, end: 12 * 60 }] });
    // Naming somebody to cover clears it (Cara holds the certificate and need not be rostered).
    const cover = ok(await coverSession(venueId, { kind: "booking", id: made.id, roleId: roleOfficer.id, personKind: "staff", personId: cara.id }, by));
    expect(cover).toEqual({ ok: true });
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.code)).toBe(false);
    const decision = (await supervisorsOf("booking", [made.id])).get(made.id)!.find((s) => s.how === "covered")!;
    expect(decision).toMatchObject({ personName: "Cara Cover", recordedByName: "Test manager" });
    // Undone, it is listed again; deliberately let stand, it needs a reason and is kept with it.
    ok(await undoDecision(venueId, decision.id));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.code)).toBe(true);
    expect((await overrideSession(venueId, { kind: "booking", id: made.id, roleId: roleOfficer.id, reason: "" }, by)).ok).toBe(false);
    ok(await overrideSession(venueId, { kind: "booking", id: made.id, roleId: roleOfficer.id, reason: "Club night, the owner is on the range" }, by));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.code)).toBe(false);
    const stand = (await supervisorsOf("booking", [made.id])).get(made.id)!.find((s) => s.how === "override")!;
    expect(stand.reason).toBe("Club night, the owner is on the range");
    // Rostering somebody again leaves the override as the record; the shift comes back.
    ok(await addShift(venueId, { roleId: roleOfficer.id, personKind: "staff", personId: ann.id, weekday: 4, fromMin: 9 * 60, toMin: 17 * 60 }));
  });

  it("will not name a cover who lacks the qualification through the session, or is somewhere else", async () => {
    const mon = ahead(1, 30);
    const made = ok(await book(archery, mon, [10])).booking;
    const leave = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: mon }));
    expect(leave.affected.map((a) => a.code)).toContain(made.code);
    // Ben's certificate ended the day before: he cannot cover a session on the day after it.
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE person_id = ?").run(ben.id);
    ok(await recordQualification(venueId, { personKind: "staff", personId: ben.id, qualification: "Range Officer Certificate", expiresOn: addDays(mon, -1) }, by));
    const lapsed = await coverSession(venueId, { kind: "booking", id: made.id, roleId: roleOfficer.id, personKind: "staff", personId: ben.id }, by);
    expect(lapsed).toMatchObject({ ok: false });
    expect((lapsed as { error: string }).error).toMatch(/does not hold/);
    // A session that needs nobody in that role cannot be covered in it.
    const guard = await coverSession(venueId, { kind: "booking", id: made.id, roleId: roleGuard.id, personKind: "staff", personId: cara.id }, by);
    expect(guard.ok).toBe(false);
    ok(await removeException(venueId, leave.exception.id));
  });

  it("lists a booking the moment a rule is added to its activity, and a class session too", async () => {
    const tue = ahead(2, 35);
    const made = ok(await book(plain, tue, [20])).booking;
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.code)).toBe(false);
    const rule = ok(await setRule(venueId, { courtId: plain, roleId: roleOfficer.id, needed: 1 }));
    expect(rule.affected.map((a) => a.code)).toContain(made.code);
    expect((await getBookingById(made.id))!.status).toBe("confirmed");
    ok(await removeRule(venueId, rule.rule.id));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.code)).toBe(false);
  });

  it("does not list a cancelled booking", async () => {
    const tue = ahead(2, 28);
    const made = ok(await book(archery, tue, [12])).booking;
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(made.id);
    const leave = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: tue }));
    expect(leave.affected.map((a) => a.code)).not.toContain(made.code);
    ok(await removeException(venueId, leave.exception.id));
  });
});

describe("a coach is one person with one schedule", () => {
  it("is not counted while teaching, and cannot be taken for a lesson while named to supervise", async () => {
    const instructor = (await listRoles(venueId)).find((r) => r.key === "instructor")!;
    ok(await saveRole(venueId, { id: instructor.id, qualification: "" }));
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 7 * 60, until: 23 * 60 }));
    const dina = await saveCoach(venueId, { name: "Coach Dina", sports: ["badminton"], rate: 40, hours });
    const evan = await saveCoach(venueId, { name: "Coach Evan", sports: ["badminton"], rate: 40, hours });
    if (!dina.ok || !evan.ok) throw new Error("coach");
    // Dina is an instructor on Sundays 08:00-20:00; courts 10 and 11 need an instructor on duty.
    ok(await addShift(venueId, { roleId: instructor.id, personKind: "coach", personId: dina.coach.id, weekday: 0, fromMin: 8 * 60, toMin: 20 * 60 }));
    const c10 = await createCourt({ venueId, name: "Court 10", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
    const c11 = await createCourt({ venueId, name: "Court 11", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!c10.ok || !c11.ok) throw new Error("court");
    ok(await setRule(venueId, { courtId: c10.court.id, roleId: instructor.id, needed: 1 }));
    ok(await setRule(venueId, { courtId: c11.court.id, roleId: instructor.id, needed: 1 }));
    const sun = ahead(0, 12);

    // A lesson with Evan at 10:00: Dina is on, and named as the supervisor.
    const lesson = ok(await book(c10.court.id, sun, [10])).booking;
    expect((await supervisorsOf("booking", [lesson.id])).get(lesson.id)![0]).toMatchObject({ personName: "Coach Dina", personKind: "coach" });
    expect(await attachCoach(lesson.id, (await coachById(evan.coach.id))!)).toMatchObject({ ok: true });

    // Dina taking a lesson herself at 12:00: she may supervise her own lesson (one session of hers) ...
    const own = ok(await book(c10.court.id, sun, [12])).booking;
    expect(await attachCoach(own.id, (await coachById(dina.coach.id))!)).toMatchObject({ ok: true });
    // ... but then she is teaching: another session at 12:00 that needs an instructor has nobody, though she is on shift.
    expect(await book(c11.court.id, sun, [12])).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    // At 14:00 she is free again.
    expect((await book(c11.court.id, sun, [14])).ok).toBe(true);

    // The other way round: named to supervise the 10:00 session, a lesson with her at 10:00 on another court is refused.
    const clash = ok(await book(c11.court.id, sun, [10])).booking;
    expect(await attachCoach(clash.id, (await coachById(dina.coach.id))!)).toMatchObject({ ok: false, code: "COACH_TAKEN" });
    // On leave she is not on shift.
    const off = ok(await addException(venueId, { kind: "leave", personKind: "coach", personId: dina.coach.id, date: addDays(sun, 7) }));
    expect(await book(c11.court.id, addDays(sun, 7), [10])).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    ok(await removeException(venueId, off.exception.id));
  });
});

