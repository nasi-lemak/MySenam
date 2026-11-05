import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { GET as uncoveredGet } from "../src/app/api/admin/roster/uncovered/route";
import { POST as rosterPost } from "../src/app/api/admin/roster/route";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { getDb } from "../src/lib/db";
import {
  STARTER_ROLES,
  addShift,
  coverSession,
  listRoles,
  overrideSession,
  previewRole,
  recommendedGaps,
  recordQualification,
  rosterFlags,
  rosterOverview,
  saveRole,
  setRule,
  supervisorsOf,
  uncoveredSessions,
  unmetNeeds,
  type RosterRole,
} from "../src/lib/rosters";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addSignOff } from "../src/lib/sign-offs";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * How firmly a role's qualification is asked (ADR 0046, which supersedes ADR 0036's rule that until a person's qualification is
 * recorded their shifts count for nothing): recommended (counts, flagged), required by the venue (counts only with it recorded and
 * unexpired), declared a legal requirement (the same, and never let stand); the starters are editable templates; a change shows its
 * effect before it is made.
 */

const ZONE = "Asia/Kuala_Lumpur";
const by = { id: null, name: "Test manager" };
let venueId: number;
let archery: number;
let instructor: RosterRole;
let officer: RosterRole;
let ann: { kind: "staff"; id: number };
let cara: { kind: "staff"; id: number };
let managerCookie: string;
let deskCookie: string;
let n = 0;
const phone = () => `0166611${String(++n).padStart(3, "0")}`;

/** The first `weekday` at least `days` ahead. */
function ahead(weekday: number, days: number): string {
  let d = addDays(todayISO(ZONE), days);
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return d;
}
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const book = async (date: string, hour: number) => {
  const p = phone();
  await addSignOff({ venueId, sport: "archery", phone: p, name: "Aziz Archer", adminId: null });
  return createBooking({ courtId: archery, date, hours: [hour], name: "Aziz Archer", phone: p, by: "staff" });
};
const level = async (key: string) => (await listRoles(venueId)).find((r) => r.key === key)!;
const asked = (date: string, hour: number, roleId: number) =>
  unmetNeeds({ venueId, courtId: archery, sport: "archery", date, span: { start: hour * 60, end: (hour + 1) * 60 }, zone: ZONE, needs: [{ roleId, roleKey: "x", roleName: "x", needed: 1 }] });
const req = (url: string, method: string, cookie: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Level Hall", area: "Ipoh", address: "x", phone: "0355550311", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(venueId);
  const court = await createCourt({ venueId, name: "Lane 1", sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!court.ok) throw new Error("court");
  archery = court.court.id;
  const staff = async (name: string, email: string, role: "manager" | "desk" = "desk") => {
    const r = await createAdmin({ name, email, password: "staff-password-1", venueId, role });
    if (!r.ok) throw new Error("staff");
    return r.admin.id;
  };
  ann = { kind: "staff", id: await staff("Ann Instructor", "ann@level.my") };
  cara = { kind: "staff", id: await staff("Cara Cover", "cara@level.my") };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(await staff("Mira Manager", "mira@level.my", "manager"))).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(await staff("Dewi Desk", "dewi@level.my"))).token}`;
  instructor = await level("instructor");
  officer = await level("range_officer");
  // The archery lane asks for one instructor on shift; Ann is the instructor, Monday to Friday, with no certificate recorded.
  ok(await setRule(venueId, { courtId: archery, roleId: instructor.id, needed: 1 }));
  for (const weekday of [1, 2, 3, 4, 5]) ok(await addShift(venueId, { roleId: instructor.id, personKind: "staff", personId: ann.id, weekday, fromMin: 9 * 60, toMin: 17 * 60 }));
});

describe("the starters are editable templates with a level each", () => {
  it("makes the instructor a recommendation and the safety roles required by the venue", async () => {
    expect(STARTER_ROLES.map((s) => [s.key, s.level])).toEqual([["range_officer", "venue_required"], ["lifeguard", "venue_required"], ["instructor", "recommended"]]);
    expect(instructor).toMatchObject({ qualification: "Instructor certificate", qualificationLevel: "recommended", qualificationReference: null });
    expect(officer).toMatchObject({ qualification: "Range officer certificate", qualificationLevel: "venue_required" });
    expect((await level("lifeguard")).qualificationLevel).toBe("venue_required");
  });

  it("gives a role of the venue's own what the venue says, and the safe default (required) where it says nothing", async () => {
    const plain = ok(await saveRole(venueId, { name: "Marshal", qualification: "Marshal badge" }));
    expect(plain.role).toMatchObject({ qualificationLevel: "venue_required", qualificationReference: null });
    const soft = ok(await saveRole(venueId, { name: "Spotter", qualification: "Spotter course", qualificationLevel: "recommended" }));
    expect(soft.role.qualificationLevel).toBe("recommended");
    expect(await saveRole(venueId, { name: "Timer", qualification: "x", qualificationLevel: "optional" })).toMatchObject({ ok: false });
  });

  it("lets a venue edit a template: lower, raise, rename or clear its qualification", async () => {
    const edited = ok(await saveRole(venueId, { id: officer.id, qualification: "NRAM range certificate", qualificationLevel: "recommended" }));
    expect(edited.role).toMatchObject({ qualification: "NRAM range certificate", qualificationLevel: "recommended" });
    ok(await saveRole(venueId, { id: officer.id, qualification: "Range officer certificate", qualificationLevel: "venue_required" }));
    expect((await level("range_officer")).qualificationLevel).toBe("venue_required");
  });
});

describe("a recommended qualification never stops anybody counting", () => {
  it("counts a person with none recorded: bookable, named on the session, and flagged as advisory", async () => {
    const tue = ahead(2, 12);
    expect(await asked(tue, 10, instructor.id)).toEqual([]);
    const made = ok(await book(tue, 10));
    const named = (await supervisorsOf("booking", [made.booking.id])).get(made.booking.id)!;
    expect(named).toEqual([expect.objectContaining({ roleKey: "instructor", personName: "Ann Instructor", how: "rostered", qualification: { why: "not_recorded", qualification: "Instructor certificate" } })]);
    const flags = await rosterFlags(venueId);
    expect(flags).toContainEqual(expect.objectContaining({ kind: "no_qualification", personId: ann.id, level: "recommended", counts: true }));
    const gaps = await recommendedGaps(venueId);
    expect(gaps.find((g) => g.code === made.booking.code)).toMatchObject({ people: [{ roleKey: "instructor", personName: "Ann Instructor", why: "not_recorded", qualification: "Instructor certificate" }] });
    // It is covered, so it is not on the list of sessions without cover.
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(false);
    expect((await rosterOverview(venueId)).advisory!.some((s) => s.code === made.booking.code)).toBe(true);
  });

  it("stops flagging once the qualification is recorded", async () => {
    const tue = ahead(2, 13);
    const made = ok(await book(tue, 10));
    ok(await recordQualification(venueId, { personKind: "staff", personId: ann.id, qualification: "instructor certificate" }, by));
    expect((await rosterFlags(venueId)).some((f) => f.personId === ann.id && f.roleId === instructor.id)).toBe(false);
    expect((await recommendedGaps(venueId)).some((g) => g.code === made.booking.code)).toBe(false);
    expect((await supervisorsOf("booking", [made.booking.id])).get(made.booking.id)![0].qualification).toBeUndefined();
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE person_id = ?").run(ann.id);
  });

  it("flags an expired one and counts the shift all the same", async () => {
    const first = ahead(2, 10);
    const after = addDays(first, 7);
    const q = ok(await recordQualification(venueId, { personKind: "staff", personId: ann.id, qualification: "Instructor certificate", expiresOn: first }, by));
    expect(await asked(after, 14, instructor.id)).toEqual([]);
    const made = ok(await book(after, 14));
    expect((await supervisorsOf("booking", [made.booking.id])).get(made.booking.id)![0].qualification).toEqual({ why: "expired", qualification: "Instructor certificate" });
    expect(await rosterFlags(venueId)).toContainEqual(expect.objectContaining({ kind: "expires", personId: ann.id, counts: true, level: "recommended" }));
    // Booked before it ended: no note.
    const early = ok(await book(first, 11));
    expect((await supervisorsOf("booking", [early.booking.id])).get(early.booking.id)![0].qualification).toBeUndefined();
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE id = ?").run(q.qualification.id);
  });

  it("lets a manager name somebody to cover who holds no recommended qualification", async () => {
    const tue = ahead(2, 14);
    const made = ok(await book(tue, 16));
    // Ann goes on leave: the session is uncovered; Cara, with no certificate at all, is named, and counts.
    const { addException, removeException } = await import("../src/lib/rosters");
    const leave = ok(await addException(venueId, { kind: "leave", personKind: "staff", personId: ann.id, date: tue }));
    expect(leave.affected.some((u) => u.code === made.booking.code)).toBe(true);
    ok(await coverSession(venueId, { kind: "booking", id: made.booking.id, roleId: instructor.id, personKind: "staff", personId: cara.id }, by));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(false);
    ok(await removeException(venueId, leave.exception.id));
  });
});

describe("a required qualification counts only where it is recorded", () => {
  it("keeps round 10's rule for what the venue requires: no certificate, no cover, and no booking", async () => {
    const mon = ahead(1, 16);
    ok(await addShift(venueId, { roleId: officer.id, personKind: "staff", personId: cara.id, weekday: 1, fromMin: 9 * 60, toMin: 17 * 60 }));
    expect((await asked(mon, 10, officer.id))[0].gaps).toHaveLength(1);
    expect(await rosterFlags(venueId)).toContainEqual(expect.objectContaining({ kind: "no_qualification", personId: cara.id, level: "venue_required", counts: false }));
    ok(await recordQualification(venueId, { personKind: "staff", personId: cara.id, qualification: "Range officer certificate" }, by));
    expect(await asked(mon, 10, officer.id)).toEqual([]);
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE person_id = ?").run(cara.id);
  });

  it("raising the instructor to required leaves the booking made under the recommendation without cover, listed for a manager", async () => {
    const wed = ahead(3, 15);
    const made = ok(await book(wed, 10));
    const raised = ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "venue_required" }));
    expect(raised.affected.some((u) => u.code === made.booking.code)).toBe(true);
    expect(await book(wed, 12)).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(true);
    // The venue may let it stand, with a reason (the round 10 decision for a required qualification).
    ok(await overrideSession(venueId, { kind: "booking", id: made.booking.id, roleId: instructor.id, reason: "Ann is certified, paperwork pending" }, by));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(false);
    ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "recommended" }));
  });
});

describe("a legal requirement is the venue's declaration, recorded, never judged and never overridden", () => {
  it("needs the qualification named and the reference given, and keeps the reference only for a legal one", async () => {
    expect(await saveRole(venueId, { id: instructor.id, qualificationLevel: "legally_required" })).toMatchObject({ ok: false });
    expect(await saveRole(venueId, { id: instructor.id, qualificationLevel: "legally_required", qualificationReference: "   " })).toMatchObject({ ok: false });
    expect(await saveRole(venueId, { id: instructor.id, qualification: "", qualificationLevel: "legally_required", qualificationReference: "Reg 12" })).toMatchObject({ ok: false });
    const legal = ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "legally_required", qualificationReference: "Sports Safety Regulations 2020, reg 12" }));
    expect(legal.role).toMatchObject({ qualificationLevel: "legally_required", qualificationReference: "Sports Safety Regulations 2020, reg 12" });
    const lowered = ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "recommended" }));
    expect(lowered.role.qualificationReference).toBeNull();
  });

  it("counts only with it recorded, cannot be let stand, and a decision made before it was legal stops covering", async () => {
    const thu = ahead(4, 18);
    const made = ok(await book(thu, 10));
    // Required by the venue first: a manager lets the session stand.
    ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "venue_required" }));
    ok(await overrideSession(venueId, { kind: "booking", id: made.booking.id, roleId: instructor.id, reason: "Certificate arrives Monday" }, by));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(false);
    // Then declared a legal requirement: the earlier decision no longer covers it, and none can be made.
    const legal = ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "legally_required", qualificationReference: "Reg 12" }));
    expect(legal.role.qualificationLevel).toBe("legally_required");
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(true);
    const refused = await overrideSession(venueId, { kind: "booking", id: made.booking.id, roleId: instructor.id, reason: "Just this once" }, by);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(await book(thu, 12)).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    // Somebody who holds it can cover it; somebody who does not, cannot.
    expect(await coverSession(venueId, { kind: "booking", id: made.booking.id, roleId: instructor.id, personKind: "staff", personId: cara.id }, by)).toMatchObject({ ok: false });
    ok(await recordQualification(venueId, { personKind: "staff", personId: cara.id, qualification: "Instructor certificate" }, by));
    ok(await coverSession(venueId, { kind: "booking", id: made.booking.id, roleId: instructor.id, personKind: "staff", personId: cara.id }, by));
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(false);
    ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "recommended" }));
    await getDb().prepare("UPDATE roster_qualifications SET revoked_at = datetime('now') WHERE person_id = ?").run(cara.id);
  });
});

describe("a change shows its effect before it is made", () => {
  it("says how many shifts hold an unrecorded qualification and which sessions would lose or gain cover, and changes nothing", async () => {
    const fri = ahead(5, 20);
    const made = ok(await book(fri, 10));
    const before = await level("instructor");
    expect(before.qualificationLevel).toBe("recommended");
    const up = ok(await previewRole(venueId, { id: instructor.id, qualificationLevel: "venue_required" }));
    expect(up.preview.shiftsWithoutIt).toBe(5);
    expect(up.preview.becomeUncovered.some((u) => u.code === made.booking.code)).toBe(true);
    expect(up.preview.becomeCovered).toEqual([]);
    expect(await level("instructor")).toEqual(before);
    expect((await uncoveredSessions([venueId])).some((u) => u.code === made.booking.code)).toBe(false);
    // From required back to recommended: the same session would be put right.
    ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "venue_required" }));
    const down = ok(await previewRole(venueId, { id: instructor.id, qualificationLevel: "recommended" }));
    expect(down.preview.becomeCovered.some((u) => u.code === made.booking.code)).toBe(true);
    expect((await level("instructor")).qualificationLevel).toBe("venue_required");
    // A preview refuses what a change would.
    expect(await previewRole(venueId, { id: instructor.id, qualificationLevel: "legally_required" })).toMatchObject({ ok: false });
    expect(await previewRole(venueId, { id: 999999, qualificationLevel: "recommended" })).toMatchObject({ ok: false, status: 404 });
    ok(await saveRole(venueId, { id: instructor.id, qualificationLevel: "recommended" }));
  });
});

describe("the routes", () => {
  const post = (body: object, cookie = managerCookie) => rosterPost(req("/api/admin/roster", "POST", cookie, { venueId, ...body }));
  const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("is a manager's: saving a level and checking one, with the change in the staff log and the check in none", async () => {
    const preview = await post({ action: "role_preview", id: instructor.id, qualificationLevel: "venue_required" });
    expect(preview.status).toBe(200);
    expect((await json(preview)).preview).toMatchObject({ shiftsWithoutIt: expect.any(Number) });
    const logged = (await listActivity([venueId])).filter((a) => a.action === "roster.role").length;
    const saved = await post({ action: "role_save", id: instructor.id, qualificationLevel: "legally_required", qualificationReference: "Reg 12" });
    expect(saved.status).toBe(200);
    expect((await json(saved)).role).toMatchObject({ qualificationLevel: "legally_required", qualificationReference: "Reg 12" });
    const entries = (await listActivity([venueId])).filter((a) => a.action === "roster.role");
    expect(entries.length).toBe(logged + 1);
    expect(entries[0].detail).toMatch(/legally required.*Reg 12/);
    expect((await post({ action: "role_save", id: instructor.id, qualificationLevel: "optional" })).status).toBe(400);
    expect((await post({ action: "role_save", id: instructor.id, qualificationLevel: "legally_required", qualificationReference: "" })).status).toBe(400);
    expect((await post({ action: "role_save", id: instructor.id, qualificationLevel: "recommended" })).status).toBe(200);
  });

  it("turns front desk away from both, and lets it read the advisory list", async () => {
    expect((await post({ action: "role_save", id: instructor.id, qualificationLevel: "venue_required" }, deskCookie)).status).toBe(403);
    expect((await post({ action: "role_preview", id: instructor.id, qualificationLevel: "venue_required" }, deskCookie)).status).toBe(403);
    expect((await level("instructor")).qualificationLevel).toBe("recommended");
    const read = await uncoveredGet(req(`/api/admin/roster/uncovered?venueId=${venueId}`, "GET", deskCookie));
    expect(read.status).toBe(200);
    expect(Array.isArray((await json(read)).advisory)).toBe(true);
  });
});

