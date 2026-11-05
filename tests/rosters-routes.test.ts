import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { GET as attentionRoute } from "../src/app/api/admin/attention/route";
import { POST as myCalendarRoute, DELETE as myCalendarStop } from "../src/app/api/admin/roster/my-calendar/route";
import { GET as rosterGet, POST as rosterPost } from "../src/app/api/admin/roster/route";
import { GET as uncoveredGet, POST as uncoveredPost } from "../src/app/api/admin/roster/uncovered/route";
import { GET as calendarFeed } from "../src/app/api/roster-calendar/[token]/route";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { coachCalendar, setCoachLink, coachForToken } from "../src/lib/coach-schedule";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { listRoles } from "../src/lib/rosters";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addSignOff } from "../src/lib/sign-offs";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * The roster's routes (ADR 0036): a manager changes it, front desk reads it, another venue's manager reaches none of it; every
 * change is in the staff log, and nothing in it cancels a booking. A person's own shifts on their own calendar link only.
 */

let venueId: number;
let otherVenueId: number;
let archery: number;
let officerRole: number;
let managerCookie: string;
let deskCookie: string;
let strangerCookie: string;
let annId: number;
let deskId: number;
let n = 0;

/** The first `weekday` at least `days` ahead. */
function ahead(weekday: number, days: number): string {
  let d = addDays(todayISO(), days);
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return d;
}

const req = (url: string, method: string, cookie: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const post = (body: object, cookie = managerCookie) => rosterPost(req("/api/admin/roster", "POST", cookie, { venueId, ...body }));
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function bookArchery(date: string, hour: number) {
  const phone = `0166600${String(++n).padStart(3, "0")}`;
  await addSignOff({ venueId, sport: "archery", phone, name: "Aziz Archer", adminId: null });
  return createBooking({ courtId: archery, date, hours: [hour], name: "Aziz Archer", phone, by: "staff" });
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Route Range", area: "Ipoh", address: "x", phone: "0355550302", openHour: 7, closeHour: 23 });
  const other = await createVenue({ name: "Other Range", area: "Ipoh", address: "y", phone: "0355550303", openHour: 7, closeHour: 23 });
  if (!made.ok || !other.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenueId = other.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id IN (?, ?)").run(venueId, otherVenueId);
  const court = await createCourt({ venueId, name: "Lane 1", sport: "archery", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!court.ok) throw new Error("court");
  archery = court.court.id;
  const manager = await createAdmin({ name: "Mira Manager", email: "mira@routes.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dewi Desk", email: "dewi@routes.my", password: "desk-password-1", venueId, role: "desk" });
  const ann = await createAdmin({ name: "Ann Officer", email: "ann@routes.my", password: "desk-password-2", venueId, role: "desk" });
  const stranger = await createAdmin({ name: "Sam Stranger", email: "sam@other.my", password: "manager-pass-2", venueId: otherVenueId });
  if (!manager.ok || !desk.ok || !ann.ok || !stranger.ok) throw new Error("staff");
  annId = ann.admin.id;
  deskId = desk.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  strangerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(stranger.admin.id)).token}`;
  officerRole = (await listRoles(venueId)).find((r) => r.key === "range_officer")!.id;
});

describe("who may read and who may change the roster", () => {
  it("lets the desk read it, and refuses it every change", async () => {
    const read = await rosterGet(req(`/api/admin/roster?venueId=${venueId}`, "GET", deskCookie));
    expect(read.status).toBe(200);
    const body = await json(read);
    expect(body.roles.map((r: { key: string }) => r.key)).toEqual(["range_officer", "lifeguard", "instructor"]);
    expect(body.people.map((p: { name: string }) => p.name)).toContain("Ann Officer");
    const refused = await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: annId, weekday: 1, fromMin: 540, toMin: 1020 }, deskCookie);
    expect(refused.status).toBe(403);
    expect((await json(refused)).code).toBe("MANAGER_ONLY");
    const decided = await uncoveredPost(req("/api/admin/roster/uncovered", "POST", deskCookie, { venueId, action: "override", kind: "booking", id: 1, roleId: officerRole, reason: "no reason" }));
    expect(decided.status).toBe(403);
    // The list of sessions without their supervisors is the desk's to read.
    expect((await uncoveredGet(req(`/api/admin/roster/uncovered?venueId=${venueId}`, "GET", deskCookie))).status).toBe(200);
  });

  it("keeps another venue's manager out", async () => {
    expect((await rosterGet(req(`/api/admin/roster?venueId=${venueId}`, "GET", strangerCookie))).status).toBe(403);
    expect((await post({ action: "role_save", name: "Marshal" }, strangerCookie)).status).toBe(403);
    expect((await uncoveredGet(req(`/api/admin/roster/uncovered?venueId=${venueId}`, "GET", strangerCookie))).status).toBe(403);
    expect((await rosterGet(req("/api/admin/roster", "GET", managerCookie))).status).toBe(400);
  });

  it("refuses an action it does not know and a body that is not an object", async () => {
    expect((await post({ action: "shift_burn" })).status).toBe(400);
    const bad = await rosterPost(req("/api/admin/roster", "POST", managerCookie));
    expect(bad.status).toBe(400);
  });
});

describe("a manager's changes", () => {
  it("roster a person, ask for them, refuse an uncovered booking, and log each change", async () => {
    // Ann's certificate, her Tuesday shift, and the rule.
    expect((await post({ action: "qualification_add", personKind: "staff", personId: annId, qualification: "Range officer certificate", reference: "RO-1234" })).status).toBe(200);
    const shift = await json(await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: annId, weekday: 2, fromMin: 9 * 60, toMin: 17 * 60 }));
    expect(shift.shift.weekday).toBe(2);
    const rule = await json(await post({ action: "rule_set", courtId: archery, roleId: officerRole, needed: 1 }));
    expect(rule.rule.needed).toBe(1);
    const tue = ahead(2, 10);
    expect((await bookArchery(tue, 10)).ok).toBe(true);
    expect(await bookArchery(tue, 19)).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    const log = (await listActivity([venueId])).map((a) => a.action);
    expect(log).toEqual(expect.arrayContaining(["roster.qualification", "roster.shift_added", "roster.rule_set"]));
  });

  it("refuses what makes no sense, in words", async () => {
    const noRole = await post({ action: "shift_add", roleId: 999999, personKind: "staff", personId: annId, weekday: 2, fromMin: 540, toMin: 600 });
    expect(noRole.status).toBe(404);
    const backwards = await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: annId, weekday: 2, fromMin: 600, toMin: 540 });
    expect(backwards.status).toBe(400);
    expect((await json(backwards)).error).toMatch(/ends after it starts/);
    const overDay = await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: annId, weekday: 2, fromMin: 600, toMin: 600 + 1441 });
    expect(overDay.status).toBe(400);
    expect((await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: 999999, weekday: 2, fromMin: 540, toMin: 600 })).status).toBe(404);
    expect((await post({ action: "rule_set", roleId: officerRole })).status).toBe(400);
    expect((await post({ action: "rule_set", courtId: archery, roleId: officerRole, needed: 0 })).status).toBe(400);
    // A person of another venue is not rostered here.
    const foreign = await createAdmin({ name: "Far Away", email: "far@other.my", password: "desk-password-3", venueId: otherVenueId, role: "desk" });
    if (!foreign.ok) throw new Error("staff");
    expect((await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: foreign.admin.id, weekday: 2, fromMin: 540, toMin: 600 })).status).toBe(404);
  });

  it("removing a shift cancels nothing, says what it uncovered, and the worklist, the attention panel and a decision follow", async () => {
    const tue = ahead(2, 14);
    const made = await bookArchery(tue, 11);
    if (!made.ok) throw new Error(JSON.stringify(made));
    const shiftId = ((await getDb().prepare("SELECT id FROM roster_shifts WHERE person_id = ? AND weekday = 2").get(annId)) as { id: number }).id;
    const removed = await json(await post({ action: "shift_remove", id: shiftId }));
    expect(removed.affected.map((a: { code: string }) => a.code)).toContain(made.booking.code);
    expect(((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(made.booking.id)) as { status: string }).status).toBe("confirmed");

    const list = await json(await uncoveredGet(req(`/api/admin/roster/uncovered?venueId=${venueId}`, "GET", deskCookie)));
    expect(list.sessions.map((s: { code: string }) => s.code)).toContain(made.booking.code);
    const attention = await json(await attentionRoute(req("/api/admin/attention", "GET", managerCookie)));
    expect(attention.uncovered.map((s: { code: string }) => s.code)).toContain(made.booking.code);
    // Another venue's manager sees none of it.
    const strangers = await json(await attentionRoute(req("/api/admin/attention", "GET", strangerCookie)));
    expect(strangers.uncovered).toEqual([]);

    // A reason is needed to let it stand; with one it leaves the list, and the log says why.
    const none = await uncoveredPost(req("/api/admin/roster/uncovered", "POST", managerCookie, { venueId, action: "override", kind: "booking", id: made.booking.id, roleId: officerRole, reason: " " }));
    expect(none.status).toBe(400);
    const stood = await json(await uncoveredPost(req("/api/admin/roster/uncovered", "POST", managerCookie, { venueId, action: "override", kind: "booking", id: made.booking.id, roleId: officerRole, reason: "Owner on the range" })));
    expect(stood.sessions.map((s: { code: string }) => s.code)).not.toContain(made.booking.code);
    const entry = (await listActivity([venueId])).find((a) => a.action === "roster.override");
    expect(entry!.detail).toContain("Owner on the range");
    // Another venue's manager cannot decide this venue's sessions.
    const trespass = await uncoveredPost(req("/api/admin/roster/uncovered", "POST", strangerCookie, { venueId, action: "override", kind: "booking", id: made.booking.id, roleId: officerRole, reason: "mine" }));
    expect(trespass.status).toBe(403);
    // And a session of one venue is not decided through another's id.
    const crossed = await uncoveredPost(req("/api/admin/roster/uncovered", "POST", strangerCookie, { venueId: otherVenueId, action: "override", kind: "booking", id: made.booking.id, roleId: officerRole, reason: "mine" }));
    expect(crossed.status).toBe(404);
  });
});

describe("a person's own shifts on their own calendar", () => {
  it("is made by the person, shows only their own shifts, and stops when they stop it", async () => {
    // Ann works Mondays as range officer; Dewi has a Monday shift too.
    await getDb().prepare("DELETE FROM roster_qualifications").run();
    await post({ action: "qualification_add", personKind: "staff", personId: annId, qualification: "Range officer certificate" });
    await post({ action: "qualification_add", personKind: "staff", personId: deskId, qualification: "Range officer certificate" });
    await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: annId, weekday: 1, fromMin: 9 * 60, toMin: 12 * 60 });
    await post({ action: "shift_add", roleId: officerRole, personKind: "staff", personId: deskId, weekday: 1, fromMin: 13 * 60, toMin: 17 * 60 });
    const annCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(annId)).token}`;
    const made = await json(await myCalendarRoute(req("/api/admin/roster/my-calendar", "POST", annCookie)));
    expect(made.url).toMatch(/\/api\/roster-calendar\/[0-9a-f]{48}\.ics$/);
    const token = made.url.split("/").pop()!.replace(".ics", "");
    // Only the hash is kept.
    const stored = (await getDb().prepare("SELECT token_hash FROM roster_calendar_links WHERE admin_id = ?").get(annId)) as { token_hash: string };
    expect(stored.token_hash).not.toContain(token);
    const feed = await calendarFeed(req(`/api/roster-calendar/${token}.ics`, "GET", ""), { params: Promise.resolve({ token: `${token}.ics` }) });
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toContain("text/calendar");
    const ics = await feed.text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:On shift: Range officer");
    // Ann's shifts are 09:00-12:00 on Mondays (01:00-04:00 UTC in Malaysia), never Dewi's 13:00-17:00 (05:00-09:00 UTC).
    expect(ics).toMatch(/DTSTART:\d{8}T010000Z/);
    expect(ics).toMatch(/DTEND:\d{8}T040000Z/);
    expect(ics).not.toMatch(/DTSTART:\d{8}T050000Z/);
    // No customer's name or number.
    expect(ics).not.toContain("Aziz");
    // A made-up token finds nothing; a new link stops the old; stopping stops it.
    expect((await calendarFeed(req("/api/roster-calendar/nothing.ics", "GET", ""), { params: Promise.resolve({ token: "nothing.ics" }) })).status).toBe(404);
    const again = await json(await myCalendarRoute(req("/api/admin/roster/my-calendar", "POST", annCookie)));
    expect((await calendarFeed(req("/x", "GET", ""), { params: Promise.resolve({ token: `${token}.ics` }) })).status).toBe(404);
    const newToken = again.url.split("/").pop()!.replace(".ics", "");
    expect((await calendarFeed(req("/x", "GET", ""), { params: Promise.resolve({ token: newToken }) })).status).toBe(200);
    expect((await myCalendarStop(req("/api/admin/roster/my-calendar", "DELETE", annCookie))).status).toBe(200);
    expect((await calendarFeed(req("/x", "GET", ""), { params: Promise.resolve({ token: newToken }) })).status).toBe(404);
    expect((await listActivity([venueId])).some((a) => a.action === "roster.calendar_link")).toBe(true);
  });

  it("puts a coach's rostered shifts on their own calendar link", async () => {
    const coach = await saveCoach(venueId, { name: "Coach Kamal", sports: ["archery"], rate: 40, hours: [{ weekday: 1, from: 8 * 60, until: 20 * 60 }] });
    if (!coach.ok) throw new Error(coach.error);
    const instructor = (await listRoles(venueId)).find((r) => r.key === "instructor")!;
    await post({ action: "role_save", id: instructor.id, qualification: "" });
    await post({ action: "shift_add", roleId: instructor.id, personKind: "coach", personId: coach.coach.id, weekday: 1, fromMin: 14 * 60, toMin: 18 * 60 });
    const link = await setCoachLink(coach.coach.id, venueId, true);
    const token = link!.link!.calendarUrl.split("/").pop()!.replace(".ics", "");
    const found = (await coachForToken(token))!;
    const ics = await coachCalendar(found, venueId);
    expect(ics).toContain("SUMMARY:On shift: Instructor");
    // 14:00-18:00 in Malaysia is 06:00-10:00 UTC; Ann's and Dewi's shifts are not on the coach's calendar.
    expect(ics).toMatch(/DTSTART:\d{8}T060000Z/);
    expect(ics).not.toMatch(/DTSTART:\d{8}T010000Z/);
  });
});
