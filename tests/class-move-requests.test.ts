import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { closeStaleRequests, decideMoveRequest, approvalReasons, classMoveRules, listMoveRequests, setClassMoveRules } from "../src/lib/class-move-requests";
import { moveClasses, previewClassMove } from "../src/lib/class-moves";
import { getDb } from "../src/lib/db";
import { addShift, listRoles, recordQualification, setRule } from "../src/lib/rosters";
import { createClassSessions, createCourt, createVenue, enrolInClass, enrolInTerm, getClass, getClassRoster, joinClassWaitlist, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as attentionRoute } from "../src/app/api/admin/attention/route";
import { GET as listRoute } from "../src/app/api/admin/class-move-requests/route";
import { POST as decideRoute } from "../src/app/api/admin/class-move-requests/[id]/route";
import { GET as settingsGet, POST as settingsPost } from "../src/app/api/admin/class-move-settings/route";
import { POST as moveRoute } from "../src/app/api/admin/classes/[id]/move/route";

/**
 * Front desk moves a class, and a consequential or exceptional move waits for a manager (lib/class-move-requests.ts, ADR 0045).
 */

let venueId: number;
let otherVenueId: number;
let managerCookie: string;
let deskCookie: string;
let otherDeskCookie: string;
let otherManagerCookie: string;
let manager: Admin;
let manager2: Admin;
let desk: Admin;
let seq = 0;
let phoneN = 0;

const day = (n: number) => addDays(todayISO(), n);
const cookieOf = async (a: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.id)).token}`;

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const other = await createVenue({ name: "Other Studio", area: "Ampang", address: "9 Jalan Lain", phone: "0388889999" });
  if (!other.ok) throw new Error("venue");
  otherVenueId = other.venue.id;
  const make = async (name: string, email: string, v: number, role?: "desk") => {
    const made = await createAdmin({ name, email, password: "staff-password-1", venueId: v, ...(role ? { role } : {}) });
    if (!made.ok) throw new Error(made.error);
    return made.admin;
  };
  manager = await make("Mona Manager", "mona-cm@venue.my", venueId);
  manager2 = await make("Maya Manager", "maya-cm@venue.my", venueId);
  desk = await make("Dan Desk", "dan-cm@venue.my", venueId, "desk");
  const otherDesk = await make("Olly Desk", "olly-cm@venue.my", otherVenueId, "desk");
  const otherManager = await make("Omar Manager", "omar-cm@venue.my", otherVenueId);
  managerCookie = await cookieOf(manager);
  deskCookie = await cookieOf(desk);
  otherDeskCookie = await cookieOf(otherDesk);
  otherManagerCookie = await cookieOf(otherManager);
});

async function studio(opts: { rates?: [number, number]; capacity?: number; venue?: number } = {}) {
  seq++;
  const made = await createCourt({
    venueId: opts.venue ?? venueId,
    name: `CM Studio ${seq}`,
    sport: "gym",
    offPeakRate: opts.rates?.[0] ?? 5,
    peakRate: opts.rates?.[1] ?? 8,
    capacity: opts.capacity ?? 10,
  });
  if (!made.ok) throw new Error("court");
  return made.court;
}

async function aClass(opts: { court?: { id: number }; weeks?: number; capacity?: number; at?: number; offset?: number; price?: number; termOff?: number; venue?: number } = {}) {
  const court = opts.court ?? (await studio({ venue: opts.venue }));
  seq++;
  const made = await createClassSessions({
    courtId: court.id,
    name: `Yoga ${seq}`,
    instructor: "Aina",
    date: day(opts.offset ?? 5),
    startHour: opts.at ?? 18,
    endHour: (opts.at ?? 18) + 1,
    capacity: opts.capacity ?? 6,
    price: opts.price ?? 20,
    weeks: opts.weeks ?? 1,
    ...(opts.termOff ? { termOffPercent: opts.termOff } : {}),
  });
  if (!made.ok) throw new Error(made.error);
  return { court, classes: made.classes };
}

async function enrol(classId: number, email?: string) {
  phoneN++;
  const r = await enrolInClass({ classId, name: `Member ${phoneN}`, phone: `0167${String(phoneN).padStart(6, "0")}`, ...(email ? { email } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}

const post = (classId: number, body: unknown, cookie = deskCookie) =>
  moveRoute(new NextRequest(`http://localhost/api/admin/classes/${classId}/move`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(classId) }),
  });
const decide = (id: number, body: unknown, cookie = managerCookie) =>
  decideRoute(new NextRequest(`http://localhost/api/admin/class-move-requests/${id}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(id) }),
  });
const list = (cookie: string, query = "") => listRoute(new NextRequest(`http://localhost/api/admin/class-move-requests${query}`, { headers: { cookie } }));
const settingsPostAs = (cookie: string, body: unknown) =>
  settingsPost(new NextRequest("http://localhost/api/admin/class-move-settings", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

const rows = async (classId: number) =>
  (await getDb().prepare("SELECT * FROM class_move_requests WHERE class_id = ? ORDER BY id").all(classId)) as { id: number; status: string; closed_reason: string | null; move_id: number | null; reasons: string }[];
const told = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE 'classmove:%'").get()) as { n: number }).n;
const reasonsOf = (r: { reasons: string }) => (JSON.parse(r.reasons) as { code: string }[]).map((x) => x.code);

async function resetRules() {
  await getDb()
    .prepare(
      `UPDATE venues SET desk_may_move_classes = TRUE, class_move_max_days = 14, class_move_max_series = 4, class_move_within_hours = 24, class_move_paid_people = NULL,
              class_move_price_check = TRUE, class_move_request_days = 7 WHERE id IN (?, ?)`
    )
    .run(venueId, otherVenueId);
}

describe("front desk moves a class", () => {
  it("makes an ordinary move at once, tells people, and logs it by the desk; the notice names no member of staff", async () => {
    await resetRules();
    const { classes } = await aClass();
    const [session] = classes;
    const email = `ordinary-${seq}@cm.my`;
    const who = await enrol(session.id, email);
    const res = await post(session.id, { date: day(12), start: "18:00" });
    expect(res.status).toBe(200);
    expect((await res.json()).told).toBe(1);
    expect((await getClass(session.id))!.date).toBe(day(12));
    expect((await getClassRoster(session.id)).map((b) => b.code)).toEqual([who.code]);
    expect(await rows(session.id)).toHaveLength(0);
    const entry = (await listActivity([venueId])).find((a) => a.action === "class.moved" && a.detail?.includes(session.name));
    expect(entry?.adminName).toBe("Dan Desk");
    const msg = (await getDb().prepare("SELECT subject, body, params FROM messages WHERE recipient = ? AND dedupe_key LIKE 'classmove:%'").get(email)) as { subject: string; body: string; params: string | null };
    expect(JSON.stringify(msg)).not.toContain("Dan Desk");
    expect(JSON.stringify(msg)).not.toContain("Dan");
  });

  it("is refused for a class of another venue, and its requests and settings are not the other venue's to read or change", async () => {
    await resetRules();
    const { classes } = await aClass();
    const theirs = await post(classes[0].id, { date: day(12), start: "18:00" }, otherDeskCookie);
    expect(theirs.status).toBe(403);
    expect((await getClass(classes[0].id))!.date).toBe(day(5));
    // A request of venue A, asked by its desk.
    const far = await post(classes[0].id, { date: day(30), start: "18:00" });
    expect(far.status).toBe(202);
    const requestId = (await far.json()).request.id as number;
    // The other venue's desk and manager: not listed, not found, not decided.
    expect((await list(otherDeskCookie, `?venueId=${venueId}`)).status).toBe(403);
    const own = await (await list(otherDeskCookie)).json();
    expect(own.requests.some((r: { id: number }) => r.id === requestId)).toBe(false);
    expect((await decide(requestId, { approve: true }, otherManagerCookie)).status).toBe(404);
    expect((await decide(requestId, { decline: true, reason: "no" }, otherManagerCookie)).status).toBe(404);
    expect((await settingsPostAs(otherManagerCookie, { venueId, deskMayMove: false })).status).toBe(403);
    expect((await settingsGet(new NextRequest(`http://localhost/api/admin/class-move-settings?venueId=${venueId}`, { headers: { cookie: otherDeskCookie } }))).status).toBe(403);
    expect((await rows(classes[0].id))[0].status).toBe("open");
  });

  it("is turned away exactly as before where a manager has turned it off, the preview too, and a manager still moves", async () => {
    await resetRules();
    const { classes } = await aClass();
    expect((await settingsPostAs(managerCookie, { venueId, deskMayMove: false })).status).toBe(200);
    for (const body of [{ date: day(12), start: "18:00" }, { date: day(12), start: "18:00", preview: true }]) {
      const res = await post(classes[0].id, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" });
    }
    expect((await getClass(classes[0].id))!.date).toBe(day(5));
    expect((await rows(classes[0].id)).length).toBe(0);
    expect((await post(classes[0].id, { date: day(12), start: "18:00" }, managerCookie)).status).toBe(200);
    const log = (await listActivity([venueId])).find((a) => a.action === "settings.changed" && a.detail?.includes("front desk may move classes true → false"));
    expect(log?.adminName).toBe("Mona Manager");
    await resetRules();
    const again = await aClass();
    expect((await post(again.classes[0].id, { date: day(12), start: "18:00" })).status).toBe(200);
  });

  it("still meets every refusal a manager's move does: what is in the way is refused with nothing stored", async () => {
    await resetRules();
    const { court, classes } = await aClass();
    await createClassSessions({ courtId: court.id, name: "Zumba", instructor: "Lina", date: day(12), startHour: 18, endHour: 19, capacity: 5, price: 10 });
    const res = await post(classes[0].id, { date: day(12), start: "18:00" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CLSA_MOVE_CLASS");
    expect((await post(classes[0].id, { date: day(-2), start: "18:00" })).status).toBe(409);
    expect(await rows(classes[0].id)).toHaveLength(0);
    expect((await getClass(classes[0].id))!.date).toBe(day(5));
  });

  it("asks the roster at the new time, as a manager's move does", async () => {
    await resetRules();
    const made = await createVenue({ name: "Roster CM Studio", area: "Ipoh", address: "x", phone: "0355550402", openHour: 7, closeHour: 23 });
    if (!made.ok) throw new Error("venue");
    const v = made.venue.id;
    await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(v);
    const room = await studio({ venue: v });
    const staff = await createAdmin({ name: "Rita Roster", email: "rita-cm@venue.my", password: "staff-password-1", venueId: v, role: "desk" });
    if (!staff.ok) throw new Error(staff.error);
    const officer = (await listRoles(v)).find((r) => r.key === "instructor")!;
    await recordQualification(v, { personKind: "staff", personId: staff.admin.id, qualification: officer.qualification ?? "instructor certificate" }, { id: null, name: "Owner" });
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) await addShift(v, { roleId: officer.id, personKind: "staff", personId: staff.admin.id, weekday, fromMin: 9 * 60, toMin: 17 * 60 });
    await setRule(v, { courtId: room.id, roleId: officer.id, needed: 1 });
    const mine = await aClass({ court: room, at: 10, offset: 5 });
    const cookie = await cookieOf(staff.admin);
    const refused = await post(mine.classes[0].id, { date: day(5), start: "18:00" }, cookie);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toMatch(/SV1_NO_SUPERVISOR/);
    expect((await getClass(mine.classes[0].id))!.startMin).toBe(10 * 60);
    expect((await post(mine.classes[0].id, { date: day(12), start: "11:00" }, cookie)).status).toBe(200);
  });
});

describe("what needs a manager's approval", () => {
  const reasonsFor = async (classId: number, to: { date: string; start: number; courtId?: number }, scope: "one" | "following" | "term" = "one", ruleOver: Record<string, unknown> = {}) => {
    await resetRules();
    if (Object.keys(ruleOver).length > 0) {
      const done = await setClassMoveRules(venueId, ruleOver);
      if (!done.ok) throw new Error(done.error);
    }
    const seen = await previewClassMove(classId, to, scope);
    if (!seen.ok) throw new Error(seen.error);
    return (await approvalReasons(venueId, seen, await classMoveRules(venueId))).map((r) => r.code);
  };

  it("nothing for the baseline: a same-price move of a week, with notices and an unpaid place, even an enrolled, paying person", async () => {
    const { classes } = await aClass();
    await enrol(classes[0].id);
    const paid = await enrol(classes[0].id);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(paid.id);
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 })).toEqual([]);
  });

  it("far: more than the days from where it was (14 by default), and the number is data", async () => {
    const { classes } = await aClass();
    expect(await reasonsFor(classes[0].id, { date: day(19), start: 18 * 60 })).toEqual([]);
    expect(await reasonsFor(classes[0].id, { date: day(26), start: 18 * 60 })).toContain("far");
    expect(await reasonsFor(classes[0].id, { date: day(26), start: 18 * 60 }, "one", { maxDays: 30, priceCheck: false })).toEqual([]);
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 }, "one", { maxDays: 6 })).toContain("far");
  });

  it("a series of more than the sessions (4 by default); a venue sets the number", async () => {
    const { classes } = await aClass({ weeks: 6 });
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 }, "term")).toContain("long_series");
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 }, "term", { maxSeries: 6 })).toEqual([]);
    const four = await aClass({ weeks: 4 });
    expect(await reasonsFor(four.classes[0].id, { date: day(12), start: 18 * 60 }, "term")).toEqual([]);
  });

  it("soon: a session that starts, or would start, within the hours (24 by default)", async () => {
    const { classes } = await aClass({ offset: 5 });
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 })).toEqual([]);
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 }, "one", { withinHours: 24 * 6 })).toContain("soon");
    // A move to a time within the hours is soon too.
    const later = await aClass({ offset: 9 });
    expect(await reasonsFor(later.classes[0].id, { date: day(1), start: 20 * 60 }, "one", { withinHours: 24 * 3, priceCheck: false })).toContain("soon");
  });

  it("waiting: people waiting for a place of it", async () => {
    const { classes } = await aClass({ capacity: 1 });
    await enrol(classes[0].id);
    expect((await joinClassWaitlist({ classId: classes[0].id, name: "Wait Wira", phone: "0170009911", email: `wait-${seq}@cm.my` })).ok).toBe(true);
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60 })).toEqual(["waiting"]);
  });

  it("a second move of the same session", async () => {
    const { classes } = await aClass();
    expect((await moveClasses({ id: null, name: "Mona" }, classes[0].id, { date: day(12), start: 18 * 60 })).ok).toBe(true);
    expect(await reasonsFor(classes[0].id, { date: day(19), start: 18 * 60 })).toEqual(["second"]);
  });

  it("price: another court whose rates differ, or a time at another rate; not a court with the same rates; and the check can be turned off", async () => {
    const { classes } = await aClass();
    const dear = await studio({ rates: [50, 80] });
    const same = await studio({ rates: [5, 8] });
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60, courtId: dear.id })).toEqual(["price"]);
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60, courtId: same.id })).toEqual([]);
    expect(await reasonsFor(classes[0].id, { date: day(12), start: 18 * 60, courtId: dear.id }, "one", { priceCheck: false })).toEqual([]);
    // Off-peak morning against the peak evening of a weekday, on the same court.
    const weekday = [...Array(14).keys()].map((n) => n + 3).find((n) => ![0, 6].includes(new Date(`${day(n)}T00:00:00Z`).getUTCDay()))!;
    const morning = await aClass({ at: 10, offset: weekday });
    expect(await reasonsFor(morning.classes[0].id, { date: day(weekday), start: 19 * 60 })).toEqual(["price"]);
  });

  it("a term or series with paid enrolments; unpaid ones need nothing", async () => {
    const { classes } = await aClass({ weeks: 3, termOff: 10 });
    const first = classes[0];
    phoneN++;
    const joined = await enrolInTerm({ classId: first.id, name: "Term Tia", phone: `0168${String(phoneN).padStart(6, "0")}` });
    if (!joined.ok) throw new Error(joined.error);
    expect(await reasonsFor(first.id, { date: day(12), start: 18 * 60 }, "term")).toEqual([]);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid' WHERE series_code = ?").run(joined.seriesCode);
    expect(await reasonsFor(first.id, { date: day(12), start: 18 * 60 }, "term")).toEqual(["paid_term"]);
    // One session of it is not a term's move.
    expect(await reasonsFor(first.id, { date: day(12), start: 18 * 60 }, "one")).toEqual([]);
  });

  it("paying people over a number the venue sets (not asked by default; 0 means any)", async () => {
    const { classes } = await aClass();
    for (let i = 0; i < 2; i++) {
      const b = await enrol(classes[0].id);
      await getDb().prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(b.id);
    }
    const free = await enrol(classes[0].id);
    expect(free.id).toBeGreaterThan(0);
    const to = { date: day(12), start: 18 * 60 };
    expect(await reasonsFor(classes[0].id, to)).toEqual([]);
    expect(await reasonsFor(classes[0].id, to, "one", { paidPeople: 0 })).toEqual(["paid_people"]);
    expect(await reasonsFor(classes[0].id, to, "one", { paidPeople: 1 })).toEqual(["paid_people"]);
    expect(await reasonsFor(classes[0].id, to, "one", { paidPeople: 2 })).toEqual([]);
  });

  it("is stored with each reason's kind, and the settings refuse a value out of range", async () => {
    await resetRules();
    const bad = await settingsPostAs(managerCookie, { venueId, maxDays: -1 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("CLS3_RULES_RANGE");
    expect((await settingsPostAs(managerCookie, { venueId, paidPeople: 1.5 })).status).toBe(400);
    expect((await settingsPostAs(managerCookie, { venueId, deskMayMove: "yes" })).status).toBe(400);
    const ok = await settingsPostAs(managerCookie, { venueId, maxDays: 30, paidPeople: 3, requestDays: 10 });
    expect((await ok.json()).rules).toMatchObject({ deskMayMove: true, maxDays: 30, maxSeries: 4, withinHours: 24, paidPeople: 3, priceCheck: true, requestDays: 10 });
    expect((await settingsPostAs(managerCookie, { venueId, paidPeople: null })).status).toBe(200);
    expect((await classMoveRules(venueId)).paidPeople).toBeNull();
    // The desk reads them and cannot change them.
    const read = await settingsGet(new NextRequest(`http://localhost/api/admin/class-move-settings?venueId=${venueId}`, { headers: { cookie: deskCookie } }));
    expect(read.status).toBe(200);
    const denied = await settingsPostAs(deskCookie, { venueId, deskMayMove: false });
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("MANAGER_ONLY");
    await resetRules();
  });
});

describe("a request that needs approval", () => {
  async function asked(opts: { people?: number; offset?: number } = {}) {
    await resetRules();
    const made = await aClass({ offset: opts.offset });
    const session = made.classes[0];
    const emails: string[] = [];
    for (let i = 0; i < (opts.people ?? 1); i++) {
      const email = `req-${seq}-${i}@cm.my`;
      emails.push(email);
      await enrol(session.id, email);
    }
    const res = await post(session.id, { date: day(30), start: "18:00", note: "The studio floor is being redone." });
    return { session, emails, res };
  }

  it("is stored, not applied: nothing moves, nobody enrolled is told, and a manager is emailed", async () => {
    const before = await told();
    const { session, res } = await asked();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.requested).toBe(true);
    expect(body.request).toMatchObject({ status: "open", className: session.name, requestedBy: "Dan Desk", note: "The studio floor is being redone." });
    expect(body.request.reasons.map((r: { code: string }) => r.code)).toContain("far");
    const now = (await getClass(session.id))!;
    expect(now).toMatchObject({ date: day(5), startMin: 18 * 60 });
    expect(await told()).toBe(before);
    expect((await getClassRoster(session.id)).every((b) => b.date === day(5))).toBe(true);
    const claims = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE class_id = ? AND active").get(session.id)) as { n: number };
    expect(claims.n).toBe(1);
    const asks = (await getDb().prepare("SELECT recipient FROM messages WHERE kind = 'staff_alert' AND recipient IN (?, ?, ?)").all("mona-cm@venue.my", "maya-cm@venue.my", "dan-cm@venue.my")) as { recipient: string }[];
    expect(asks.map((a) => a.recipient)).toEqual(expect.arrayContaining(["mona-cm@venue.my", "maya-cm@venue.my"]));
    expect(asks.map((a) => a.recipient)).not.toContain("dan-cm@venue.my");
    const log = (await listActivity([venueId])).find((a) => a.action === "class.move_requested" && a.detail?.includes(session.name));
    expect(log?.adminName).toBe("Dan Desk");
    expect(log?.detail).toContain("needs approval");
    // A second request for it, while one waits: refused.
    const again = await post(session.id, { date: day(31), start: "18:00" });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("CLS3_REQ_OPEN");
    expect(await rows(session.id)).toHaveLength(1);
  });

  it("is previewed to the desk with why, and a manager's own preview carries no approval", async () => {
    await resetRules();
    const { classes } = await aClass();
    const seenByDesk = await (await post(classes[0].id, { date: day(30), start: "18:00", preview: true })).json();
    expect(seenByDesk.approval.required).toBe(true);
    expect(seenByDesk.approval.reasons.map((r: { code: string; kind: string }) => [r.code, r.kind])).toContainEqual(["far", "exceptional"]);
    const plain = await (await post(classes[0].id, { date: day(12), start: "18:00", preview: true })).json();
    expect(plain.approval).toEqual({ required: false, reasons: [] });
    const seenByManager = await (await post(classes[0].id, { date: day(30), start: "18:00", preview: true }, managerCookie)).json();
    expect(seenByManager.approval).toBeUndefined();
    expect(await rows(classes[0].id)).toHaveLength(0);
  });

  it("a manager's own move never needs approval, whatever it is", async () => {
    await resetRules();
    const { classes } = await aClass({ weeks: 6 });
    const res = await post(classes[0].id, { date: day(40), start: "10:00", scope: "term" }, managerCookie);
    expect(res.status).toBe(200);
    expect(await rows(classes[0].id)).toHaveLength(0);
  });

  it("is approved by a manager: the class moves, everyone is told once, the desk is told, and it is all in the log", async () => {
    const { session, emails, res } = await asked({ people: 2 });
    const request = (await res.json()).request;
    const before = await told();
    const done = await decide(request.id, { approve: true, note: "Fine, the floor is being redone." });
    expect(done.status).toBe(200);
    const out = await done.json();
    expect(out.told).toBe(2);
    expect(out.request).toMatchObject({ status: "approved", decidedBy: "Mona Manager" });
    expect((await getClass(session.id))!.date).toBe(day(30));
    for (const b of await getClassRoster(session.id)) expect(b.date).toBe(day(30));
    expect(await told()).toBe(before + 2);
    for (const email of emails) expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = ? AND dedupe_key LIKE 'classmove:%'").get(email)) as { n: number }).n).toBe(1);
    const [row] = await rows(session.id);
    expect(row.status).toBe("approved");
    expect(row.move_id).toBe(out.moveId);
    const move = (await getDb().prepare("SELECT moved_by_name FROM class_moves WHERE id = ?").get(out.moveId)) as { moved_by_name: string };
    expect(move.moved_by_name).toBe("Mona Manager");
    const log = await listActivity([venueId]);
    const approved = log.find((a) => a.action === "class.move_approved" && a.detail?.includes(session.name));
    expect(approved?.adminName).toBe("Mona Manager");
    expect(approved?.detail).toContain("asked by Dan Desk");
    const moved = log.find((a) => a.action === "class.moved" && a.detail?.includes(session.name));
    expect(moved?.adminName).toBe("Mona Manager");
    expect(moved?.detail).toContain("requested by Dan Desk, approved by Mona Manager");
    expect(moved?.detail).toContain("far");
    const toDesk = (await getDb().prepare("SELECT subject, params FROM messages WHERE kind = 'staff_alert' AND recipient = 'dan-cm@venue.my' ORDER BY id DESC LIMIT 1").get()) as { subject: string; params: string };
    expect(JSON.stringify(toDesk)).toContain("approved");
    // Decided: a second decision is refused, a request of it is not open any more.
    const again = await decide(request.id, { approve: true });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("CLS3_REQ_DECIDED");
  });

  it("is declined with a reason: nothing moves, nobody is told, the reason is kept, and the desk is told", async () => {
    const { session, res } = await asked();
    const request = (await res.json()).request;
    const before = await told();
    const noReason = await decide(request.id, { decline: true });
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).code).toBe("CLS3_REASON");
    expect((await decide(request.id, { decline: true, reason: "   " })).status).toBe(400);
    expect((await decide(request.id, {})).status).toBe(400);
    expect((await decide(request.id, { approve: true, decline: true, reason: "x" })).status).toBe(400);
    const declined = await decide(request.id, { decline: true, reason: "Keep it where it is." });
    expect(declined.status).toBe(200);
    expect((await declined.json()).request).toMatchObject({ status: "declined", decisionNote: "Keep it where it is.", decidedBy: "Mona Manager" });
    expect((await getClass(session.id))!.date).toBe(day(5));
    expect(await told()).toBe(before);
    expect((await rows(session.id))[0].move_id).toBeNull();
    const log = (await listActivity([venueId])).find((a) => a.action === "class.move_declined" && a.detail?.includes(session.name));
    expect(log?.detail).toContain("declined: Keep it where it is.");
    const toDesk = (await getDb().prepare("SELECT params FROM messages WHERE kind = 'staff_alert' AND recipient = 'dan-cm@venue.my' ORDER BY id DESC LIMIT 1").get()) as { params: string };
    expect(toDesk.params).toContain("Keep it where it is.");
    // Declined: the desk may ask again.
    expect((await post(session.id, { date: day(31), start: "18:00" })).status).toBe(202);
  });

  it("the desk cannot decide it, and only sees what its venue has", async () => {
    const { res } = await asked();
    const request = (await res.json()).request;
    const refused = await decide(request.id, { approve: true }, deskCookie);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("MANAGER_ONLY");
    expect((await rows(request.classId))[0].status).toBe("open");
    const seen = await (await list(deskCookie)).json();
    const mine = seen.requests.find((r: { id: number }) => r.id === request.id);
    expect(mine).toMatchObject({ status: "open", requestedByMe: true, className: request.className });
    // Counts only: nobody enrolled is named.
    expect(JSON.stringify(seen)).not.toContain("Member ");
    // Needs attention: a manager sees it to decide; the desk sees it waiting.
    const att = await (await attentionRoute(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: managerCookie } }))).json();
    expect(att.classMoveRequests.some((r: { id: number }) => r.id === request.id)).toBe(true);
    const attDesk = await (await attentionRoute(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: deskCookie } }))).json();
    expect(attDesk.classMoveRequests.some((r: { id: number }) => r.id === request.id)).toBe(true);
    const attOther = await (await attentionRoute(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: otherManagerCookie } }))).json();
    expect(attOther.classMoveRequests.some((r: { id: number }) => r.id === request.id)).toBe(false);
  });

  it("closes itself when its days pass, naming nothing but that: and cannot then be approved", async () => {
    const { session, res } = await asked();
    const request = (await res.json()).request;
    await getDb().prepare("UPDATE class_move_requests SET expires_at = now() - interval '1 minute' WHERE id = ?").run(request.id);
    expect(await closeStaleRequests([venueId])).toBe(1);
    const [row] = await rows(session.id);
    expect(row.status).toBe("expired");
    const log = (await listActivity([venueId])).find((a) => a.action === "class.move_request_closed" && a.detail?.includes(session.name));
    expect(log?.adminName).toBe("System");
    expect(log?.detail).toContain("no decision in time");
    const late = await decide(request.id, { approve: true });
    expect(late.status).toBe(409);
    expect((await getClass(session.id))!.date).toBe(day(5));
    // The days are the venue's, and never past the class's start.
    await setClassMoveRules(venueId, { requestDays: 2 });
    const next = await aClass({ offset: 1 });
    const second = await post(next.classes[0].id, { date: day(30), start: "18:00" });
    const expires = new Date((await second.json()).request.expiresAt).getTime();
    expect(expires).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000 + 1000);
    expect(expires).toBeLessThanOrEqual(new Date(`${day(1)}T23:59:00Z`).getTime());
    await resetRules();
  });

  it("closes with the reason where the class has begun, been cancelled or been moved meanwhile", async () => {
    const started = await asked();
    await getDb().prepare("UPDATE classes SET date = ? WHERE id = ?").run(day(-1), started.session.id);
    const cancelled = await asked();
    await getDb().prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(cancelled.session.id);
    const moved = await asked();
    expect((await moveClasses({ id: null, name: "Mona" }, moved.session.id, { date: day(8), start: 18 * 60 })).ok).toBe(true);
    // Reading the list closes them.
    const seen = (await (await list(managerCookie)).json()).requests as { classId: number; status: string; closedReason: string | null }[];
    const of = (id: number) => seen.find((r) => r.classId === id)!;
    expect(of(started.session.id)).toMatchObject({ status: "closed", closedReason: "started" });
    expect(of(cancelled.session.id)).toMatchObject({ status: "closed", closedReason: "cancelled" });
    expect(of(moved.session.id)).toMatchObject({ status: "closed", closedReason: "changed" });
    expect((await decide((await rows(moved.session.id))[0].id, { approve: true })).status).toBe(409);
    expect((await getClass(moved.session.id))!.date).toBe(day(8));
  });

  it("refuses an approval, and closes the request, when somebody enrolled or left since it was asked", async () => {
    const { session, res } = await asked();
    const request = (await res.json()).request;
    await enrol(session.id, `late-${seq}@cm.my`);
    const before = await told();
    const refused = await decide(request.id, { approve: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("CLS3_REQ_CHANGED");
    expect((await getClass(session.id))!.date).toBe(day(5));
    expect(await told()).toBe(before);
    expect((await rows(session.id))[0]).toMatchObject({ status: "closed", closed_reason: "changed" });
    // The desk asks again, and now it holds.
    const second = await post(session.id, { date: day(30), start: "18:00" });
    expect(second.status).toBe(202);
    expect((await decide((await second.json()).request.id, { approve: true })).status).toBe(200);
  });

  it("refuses an approval that something now stands in the way of, with what, and the request waits", async () => {
    const { session, res } = await asked();
    const request = (await res.json()).request;
    await createClassSessions({ courtId: session.courtId, name: "Squatter", instructor: "Z", date: day(30), startHour: 18, endHour: 19, capacity: 2, price: 1 });
    const refused = await decide(request.id, { approve: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("CLSA_MOVE_CLASS");
    expect((await getClass(session.id))!.date).toBe(day(5));
    expect((await rows(session.id))[0].status).toBe("open");
    expect((await decide(request.id, { decline: true, reason: "Taken." })).status).toBe(200);
  });

  it("two managers approving at once make one move: the other is told it is decided", async () => {
    const { session, res } = await asked({ people: 2 });
    const request = (await res.json()).request;
    const before = await told();
    const [a, b] = await Promise.all([decideMoveRequest(manager, request.id, { approve: true }), decideMoveRequest(manager2, request.id, { approve: true })]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok)!;
    expect(lost.ok ? null : lost.status).toBe(409);
    expect(lost.ok ? null : lost.code).toBe("CLS3_REQ_DECIDED");
    expect((await getClass(session.id))!.date).toBe(day(30));
    const moves = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM class_move_sessions WHERE class_id = ?").get(session.id)) as { n: number };
    expect(moves.n).toBe(1);
    expect(await told()).toBe(before + 2);
    expect((await rows(session.id))[0].status).toBe("approved");
    expect(reasonsOf((await rows(session.id))[0])).toContain("far");
  });

  it("an enrolment at the moment of approval leaves the class and its roster together: moved with everyone, or not moved and the request closed as changed", async () => {
    for (let round = 0; round < 3; round++) {
      const { session, res } = await asked({ people: 1 });
      const request = (await res.json()).request;
      phoneN++;
      const [approved, enrolled] = await Promise.all([
        decideMoveRequest(manager, request.id, { approve: true }),
        enrolInClass({ classId: session.id, name: `Racer ${phoneN}`, phone: `0169${String(phoneN).padStart(6, "0")}` }),
      ]);
      const now = (await getClass(session.id))!;
      const roster = await getClassRoster(session.id);
      // Everybody holding a place is always where the class is.
      for (const b of roster.filter((x) => x.status === "confirmed")) expect(b.date).toBe(now.date);
      if (approved.ok) {
        expect(now.date).toBe(day(30));
        expect((await rows(session.id))[0].status).toBe("approved");
      } else {
        expect(approved.code).toBe("CLS3_REQ_CHANGED");
        expect(now.date).toBe(day(5));
        expect((await rows(session.id))[0]).toMatchObject({ status: "closed", closed_reason: "changed" });
        expect(enrolled.ok).toBe(true);
      }
    }
  });

  it("a desk of another venue is not told of, and a manager of another venue cannot see, the request in the list", async () => {
    const { res } = await asked();
    const request = (await res.json()).request;
    expect((await (await list(otherManagerCookie)).json()).requests.some((r: { id: number }) => r.id === request.id)).toBe(false);
    expect((await listMoveRequests({ id: 0, venueIds: [otherVenueId] })).some((r) => r.id === request.id)).toBe(false);
    expect((await listMoveRequests({ id: 0, venueIds: null })).some((r) => r.id === request.id)).toBe(true);
  });
});
