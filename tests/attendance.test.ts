import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import {
  addWalkIn,
  attendanceCsv,
  attendanceExport,
  attendanceReport,
  attendanceTaken,
  CSV_COLUMNS,
  lockRegister,
  markAttendance,
  myAttendance,
  registerFor,
  removeWalkIn,
  sessionInfo,
  staffViewer,
  type Viewer,
} from "../src/lib/attendance";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { setCoachLink } from "../src/lib/coach-schedule";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { eraseCustomer, exportCustomerData, pruneOldData, retentionDue } from "../src/lib/privacy";
import { eraseParticipant } from "../src/lib/participants";
import { addDays, todayISO } from "../src/lib/time";
import { createClassSessions, createCourt, createVenue, enrolInClass, enrolPeople, issuePass, listBookingsForDate, setPaymentStatus } from "../src/lib/store";
import * as attendanceRoute from "../src/app/api/admin/attendance/route";
import * as lockRoute from "../src/app/api/admin/attendance/lock/route";
import * as reportRoute from "../src/app/api/admin/attendance/report/route";
import * as settingsRoute from "../src/app/api/admin/lesson-settings/route";
import * as coachRegisterRoute from "../src/app/api/coach/[token]/register/route";
import * as myAttendanceRoute from "../src/app/api/my/attendance/route";
import { POST as bookRoute } from "../src/app/api/bookings/route";

/**
 * The attendance register (lib/attendance.ts; docs/features/programmes.md#attendance-registers; ADR 0042): who is expected at a class's
 * session or a coached lesson, walk-ins, the four marks, who may mark when (the instructor at their link, the desk, a manager), locking
 * and corrections with a reason, the report and its spreadsheet, what a customer and a guardian see, the data export, erasure, retention,
 * and the proof that a mark moves no money and changes no pass.
 */

const ZONE = "Asia/Kuala_Lumpur";
const H = (h: number) => h * 60;
const day = (k: number) => addDays(todayISO(ZONE), k);
/** Noon at the venue on a date: a moment on that day, whatever the machine's clock. */
const noonOn = (date: string) => new Date(`${date}T12:00:00+08:00`);
let n = 0;
let venueId: number;
let otherVenueId: number;
let ana: { id: number; name: string };
let ben: { id: number; name: string };
let manager: Viewer;
let desk: Viewer;
let managerCookie: string;
let deskCookie: string;
let otherCookie: string;
let adminIds: { manager: number; desk: number };

const phone = () => `0165${String(++n).padStart(6, "0")}`;
const cookieFor = async (adminId: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}`;
async function staff(name: string, role: "manager" | "desk", venue = venueId) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@att.test`, password: "a long enough password", venueId: venue, role });
  if (!made.ok) throw new Error(made.error);
  return made.admin;
}
async function account(name = "Parent") {
  const made = await registerUser({ name: `${name} ${++n}`, email: `att${n}@att.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** A class session `k` days ahead, evening, on the shared floor. */
async function aClass(k: number, opts: { weeks?: number; capacity?: number } = {}) {
  // Its own room: a room holds one class at a time.
  const room = await createCourt({ venueId, name: `Studio ${++n}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
  if (!room.ok) throw new Error("room");
  const made = await createClassSessions({ courtId: room.court.id, name: `Junior tennis ${++n}`, instructor: "Coach Lim", date: day(k), start: H(17), end: H(18), capacity: opts.capacity ?? 8, price: 15, weeks: opts.weeks ?? 1 });
  if (!made.ok) throw new Error(made.error);
  return made.classes;
}
async function enrolled(classId: number, name = `Pupil ${++n}`) {
  const r = await enrolInClass({ classId, name, phone: phone() });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}
/** A lesson with `coach`, booked online, an hour at `hour` on `date`. */
async function lesson(coach: { id: number }, date: string, hour: number) {
  const res = await bookRoute(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.99.${++n % 250}.${n % 200}` },
      body: JSON.stringify({ venueId, sport: "tennis", date, start: H(hour), end: H(hour + 1), name: `Pupil ${++n}`, phone: phone(), coachId: coach.id }),
    })
  );
  const body = await res.json();
  if (res.status !== 201) throw new Error(JSON.stringify(body));
  return { id: body.booking.id as number, code: body.booking.code as string };
}
const mark = (viewer: Viewer, ref: { kind: "class" | "lesson"; id: number }, key: string, m: string, extra: Record<string, unknown> = {}, now?: Date) =>
  markAttendance(viewer, ref, { key, mark: m, ...extra }, now);
const reg = async (viewer: Viewer, ref: { kind: "class" | "lesson"; id: number }, now?: Date) => {
  const r = await registerFor(viewer, ref, now);
  if (!("lines" in r)) throw new Error(`refused: ${r.error}`);
  return r;
};
const coachViewer = (c: { id: number; name: string }): Viewer => ({ kind: "coach", coachId: c.id, name: c.name });

beforeAll(async () => {
  const made = await createVenue({ name: "Register Club", area: "Bangsar", address: "1 Jalan Hadir", phone: "0322220000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const other = await createVenue({ name: "Other Club", area: "Cheras", address: "2 Jalan Lain", phone: "0322221111" });
  if (!other.ok) throw new Error("venue");
  otherVenueId = other.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "tennis", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: H(8), until: H(21) }));
  for (const [name, set] of [["Ana Lim", (k: typeof ana) => (ana = k)], ["Ben Tan", (k: typeof ben) => (ben = k)]] as const) {
    const s = await saveCoach(venueId, { name, sports: ["tennis"], rate: 80, hours });
    if (!s.ok) throw new Error(s.error);
    set({ id: s.coach.id, name: s.coach.name });
  }
  const m = await staff("Mei Manager", "manager");
  const d = await staff("Dino Desk", "desk");
  const o = await staff("Olive Other", "manager", otherVenueId);
  adminIds = { manager: m.id, desk: d.id };
  manager = staffViewer({ id: m.id, name: m.name, role: "manager" });
  desk = staffViewer({ id: d.id, name: d.name, role: "desk" });
  managerCookie = await cookieFor(m.id);
  deskCookie = await cookieFor(d.id);
  otherCookie = await cookieFor(o.id);
});

describe("who is expected, and the four marks", () => {
  it("lists each place of each enrolment, the customer's own and a child's by their participant record, in full to staff", async () => {
    const [cls] = await aClass(2, { capacity: 6 });
    const mum = await account("Mum");
    const kid = await addManaged(mum.id, { displayName: "Amira Binti Ali", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error(kid.error);
    expect((await enrolPeople({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: [{ id: kid.person.id, name: kid.person.displayName }, null] })).ok).toBe(true);
    await enrolled(cls.id, "Walk Past Wei");
    const r = await reg(manager, { kind: "class", id: cls.id });
    expect(r.lines.map((l) => l.name).sort()).toEqual(["Amira Binti Ali", mum.name, "Walk Past Wei"].sort());
    expect(r.lines.find((l) => l.name === "Amira Binti Ali")).toMatchObject({ booked_for: true, walkIn: false, mark: null });
    // Staff see how to reach each; a coach would not.
    expect(r.lines.every((l) => l.bookingCode && l.phone)).toBe(true);
    expect(r.phase).toBe("early");
  });

  it("takes present, absent, late and excused with a note, who marked it and when; a change is kept with what it was", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id, "Nadia");
    const ref = { kind: "class" as const, id: cls.id };
    const now = noonOn(cls.date);
    const key = `c:${b.id}`;
    const first = await mark(desk, ref, key, "late", { note: "  bus   was late " }, now);
    expect(first).toMatchObject({ ok: true, was: null, late: false });
    expect(first.ok && first.line).toMatchObject({ mark: "late", note: "bus was late", markedBy: "Dino Desk" });
    const second = await mark(desk, ref, key, "present", {}, now);
    expect(second).toMatchObject({ ok: true, was: "late" });
    for (const m of ["absent", "excused", "present"]) expect((await mark(desk, ref, key, m, {}, now)).ok).toBe(true);
    const r = await reg(manager, ref, now);
    expect(r.lines[0]).toMatchObject({ mark: "present", changes: 4 });
    expect(r.history!.map((h) => `${h.was}>${h.now}`)).toEqual(["excused>present", "absent>excused", "present>absent", "late>present"]);
    // Nothing else is a mark, and nobody who is not on the list is marked.
    expect(await mark(desk, ref, key, "sick", {}, now)).toMatchObject({ ok: false, code: "ATTENDANCE_MARK" });
    expect(await mark(desk, ref, "c:999999", "present", {}, now)).toMatchObject({ ok: false, code: "ATTENDANCE_PERSON" });
    // The same mark again changes nothing.
    expect(await mark(desk, ref, key, "present", {}, now)).toMatchObject({ ok: true, was: "present" });
    expect((await reg(manager, ref, now)).lines[0].changes).toBe(4);
  });

  it("is declared, not verified: it counts as taken only for present or late", async () => {
    const [cls] = await aClass(1);
    const a = await enrolled(cls.id);
    const b = await enrolled(cls.id);
    const ref = { kind: "class" as const, id: cls.id };
    const now = noonOn(cls.date);
    await mark(desk, ref, `c:${a.id}`, "absent", {}, now);
    await mark(desk, ref, `c:${b.id}`, "excused", {}, now);
    expect(await attendanceTaken(ref)).toBe(false);
    await mark(desk, ref, `c:${b.id}`, "late", {}, now);
    expect(await attendanceTaken(ref)).toBe(true);
  });
});

describe("walk-ins", () => {
  it("are added by name, marked present unless said, and taken off again if added by mistake", async () => {
    const [cls] = await aClass(1);
    const ref = { kind: "class" as const, id: cls.id };
    const now = noonOn(cls.date);
    const added = await addWalkIn(desk, ref, { name: "  Raj   from next door " }, now);
    expect(added.ok && added.line).toMatchObject({ name: "Raj from next door", walkIn: true, mark: "present" });
    expect(await addWalkIn(desk, ref, { name: "   " }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_NAME" });
    expect(await addWalkIn(desk, ref, { name: "Lia", mark: "maybe" }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_MARK" });
    const key = added.ok ? added.line.key : "";
    expect((await mark(desk, ref, key, "late", {}, now)).ok).toBe(true);
    expect(await removeWalkIn(desk, ref, { key }, now)).toMatchObject({ ok: true });
    expect((await reg(desk, ref, now)).lines).toHaveLength(0);
    // Somebody on the list is marked, never removed.
    const b = await enrolled(cls.id);
    expect(await removeWalkIn(desk, ref, { key: `c:${b.id}` }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_PERSON" });
  });

  it("are limited to what one session takes", async () => {
    const [cls] = await aClass(1);
    const ref = { kind: "class" as const, id: cls.id };
    const now = noonOn(cls.date);
    for (let i = 0; i < 50; i++) expect((await addWalkIn(desk, ref, { name: `Walk ${i}` }, now)).ok).toBe(true);
    expect(await addWalkIn(desk, ref, { name: "One too many" }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_WALK_INS" });
  });
});

describe("who may mark, and when", () => {
  it("opens on the day: the desk and the instructor are refused before it, a manager is not", async () => {
    const [cls] = await aClass(3);
    const b = await enrolled(cls.id);
    const ref = { kind: "class" as const, id: cls.id };
    const before = noonOn(addDays(cls.date, -1));
    expect(await mark(desk, ref, `c:${b.id}`, "present", {}, before)).toMatchObject({ ok: false, code: "ATTENDANCE_EARLY" });
    expect(await addWalkIn(desk, ref, { name: "Early" }, before)).toMatchObject({ ok: false, code: "ATTENDANCE_EARLY" });
    expect((await mark(manager, ref, `c:${b.id}`, "present", {}, before)).ok).toBe(true);
    const seen = await reg(desk, ref, before);
    expect(seen).toMatchObject({ phase: "early", canMark: false });
    expect((await reg(manager, ref, before)).canMark).toBe(true);
    expect(await mark(desk, ref, `c:${b.id}`, "late", {}, noonOn(cls.date))).toMatchObject({ ok: true });
  });

  it("stays editable for the venue's days after the session, then only a manager corrects it, with a reason", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    const ref = { kind: "class" as const, id: cls.id };
    const key = `c:${b.id}`;
    await getDb().prepare("UPDATE venues SET attendance_lock_days = 3 WHERE id = ?").run(venueId);
    try {
      await mark(desk, ref, key, "present", {}, noonOn(cls.date));
      expect((await mark(desk, ref, key, "absent", {}, noonOn(addDays(cls.date, 3)))).ok).toBe(true);
      const late = noonOn(addDays(cls.date, 4));
      expect(await mark(desk, ref, key, "present", {}, late)).toMatchObject({ ok: false, code: "ATTENDANCE_CLOSED" });
      expect(await mark(coachViewer(ana), ref, key, "present", {}, late)).toMatchObject({ ok: false });
      expect(await mark(manager, ref, key, "present", {}, late)).toMatchObject({ ok: false, code: "ATTENDANCE_REASON" });
      expect(await mark(manager, ref, key, "present", { reason: "ok" }, late)).toMatchObject({ ok: false, code: "ATTENDANCE_REASON" });
      const fixed = await mark(manager, ref, key, "present", { reason: "Parent showed us the sign-in sheet" }, late);
      expect(fixed).toMatchObject({ ok: true, late: true, was: "absent" });
      const r = await reg(manager, ref, late);
      expect(r).toMatchObject({ phase: "closed", canMark: false, canCorrect: true });
      expect(r.history![0]).toMatchObject({ was: "absent", now: "present", late: true, by: "Mei Manager", reason: "Parent showed us the sign-in sheet" });
      // The desk's own view carries no history.
      expect((await reg(desk, ref, late)).history).toBeUndefined();
      // A walk-in after the register closed is a correction too.
      expect(await addWalkIn(manager, ref, { name: "Latecomer", reason: "Forgot to add" }, late)).toMatchObject({ ok: true, late: true });
      expect(await addWalkIn(manager, ref, { name: "Latecomer 2" }, late)).toMatchObject({ ok: false, code: "ATTENDANCE_REASON" });
    } finally {
      await getDb().prepare("UPDATE venues SET attendance_lock_days = 14 WHERE id = ?").run(venueId);
    }
  });

  it("is closed by a manager's lock, whatever the day, and opened again by one; the desk cannot lock", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    const ref = { kind: "class" as const, id: cls.id };
    const now = noonOn(cls.date);
    await mark(desk, ref, `c:${b.id}`, "present", {}, now);
    expect(await lockRegister(desk, ref, true, now)).toMatchObject({ ok: false, code: "ATTENDANCE_MANAGER" });
    expect(await lockRegister(manager, ref, true, now)).toMatchObject({ ok: true, locked: true });
    expect((await reg(desk, ref, now)).locked).toMatchObject({ by: "Mei Manager" });
    expect(await mark(desk, ref, `c:${b.id}`, "absent", {}, now)).toMatchObject({ ok: false, code: "ATTENDANCE_CLOSED" });
    expect(await addWalkIn(desk, ref, { name: "Too late" }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_CLOSED" });
    expect(await lockRegister(manager, ref, false, now)).toMatchObject({ ok: true, locked: false });
    expect(await mark(desk, ref, `c:${b.id}`, "absent", {}, now)).toMatchObject({ ok: true, was: "present" });
  });

  it("is closed for a cancelled session", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    await getDb().prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(cls.id);
    expect(await mark(manager, { kind: "class", id: cls.id }, `c:${b.id}`, "present", {}, noonOn(cls.date))).toMatchObject({ ok: false, code: "ATTENDANCE_CANCELLED" });
  });
});

describe("the instructor, at their own link", () => {
  it("sees and marks only the lessons that are theirs, by name and not by number", async () => {
    const date = day(2);
    const mine = await lesson(ana, date, 9);
    const his = await lesson(ben, date, 11);
    const now = noonOn(date);
    const asAna = coachViewer(ana);
    const r = await reg(asAna, { kind: "lesson", id: mine.id }, now);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ bookingCode: null, phone: null });
    expect(r.session.title).toBe("Ana Lim");
    expect(await registerFor(asAna, { kind: "lesson", id: his.id }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_NOT_FOUND" });
    expect(await mark(asAna, { kind: "lesson", id: his.id }, `c:${his.id}`, "present", {}, now)).toMatchObject({ ok: false, code: "ATTENDANCE_NOT_FOUND" });
    expect(await mark(asAna, { kind: "lesson", id: mine.id }, `c:${mine.id}`, "present", { note: "good footwork" }, now)).toMatchObject({ ok: true });
    // A class whose instructor is only a name has no coach to mark it.
    const [cls] = await aClass(1);
    expect(await registerFor(asAna, { kind: "class", id: cls.id }, now)).toMatchObject({ ok: false, code: "ATTENDANCE_NOT_FOUND" });
    // A coach never locks.
    expect(await lockRegister(asAna, { kind: "lesson", id: mine.id }, true, now)).toMatchObject({ ok: false, code: "ATTENDANCE_MANAGER" });
  });

  it("works through the private link's own route, logged under their name, and a lesson of another coach is not found", async () => {
    // The lessons are booked ahead (a booking made after its own start is refused, whatever the time of day the suite runs), and the
    // route is then read as if it were noon on that day, when the register is open: only the clock's date is faked.
    const date = day(1);
    const mine = await lesson(ana, date, 20);
    const his = await lesson(ben, date, 19);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(noonOn(date));
    try {
    const link = await setCoachLink(ana.id, venueId, true);
    const token = link!.link!.pageUrl.split("/coach/")[1];
    const params = { params: Promise.resolve({ token }) };
    // Today, at the venue: the register is open from the day.
    const got = await coachRegisterRoute.GET(req(`http://localhost/api/coach/${token}/register?id=${mine.id}`, "GET", null), params);
    expect(got.status).toBe(200);
    const register = (await got.json()).register;
    expect(register.phase).toBe("open");
    const posted = await coachRegisterRoute.POST(req(`http://localhost/api/coach/${token}/register`, "POST", null, { id: mine.id, action: "mark", key: `c:${mine.id}`, mark: "present", note: "on time" }), params);
    expect(posted.status).toBe(200);
    expect((await posted.json()).line).toMatchObject({ mark: "present", markedBy: "Ana Lim" });
    expect((await coachRegisterRoute.GET(req(`http://localhost/api/coach/${token}/register?id=${his.id}`, "GET", null), params)).status).toBe(404);
    expect((await coachRegisterRoute.POST(req(`http://localhost/api/coach/${token}/register`, "POST", null, { id: his.id, action: "walkin", name: "Intruder" }), params)).status).toBe(404);
    const walk = await coachRegisterRoute.POST(req(`http://localhost/api/coach/${token}/register`, "POST", null, { id: mine.id, action: "walkin", name: "Sibling" }), params);
    expect(walk.status).toBe(201);
    // A link that is not one.
    expect((await coachRegisterRoute.GET(req(`http://localhost/api/coach/${"x".repeat(30)}/register?id=${mine.id}`, "GET", null), { params: Promise.resolve({ token: "x".repeat(30) }) })).status).toBe(404);
    const log = (await listActivity([venueId])).filter((a) => a.action === "attendance.marked" && a.adminName === "Ana Lim");
    expect(log.length).toBe(2);
    expect(log[0].detail).toContain("at their own link");
    // The log names the session and the mark, never the person.
    expect(log.map((l) => l.detail).join(" ")).not.toContain("Sibling");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the dashboard's routes", () => {
  it("lets the desk read and mark on the day, refuses the lock, report and settings to the desk, and keeps a venue's registers to its own staff", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    await getDb().prepare("UPDATE classes SET date = ? WHERE id = ?").run(todayISO(ZONE), cls.id);
    const read = await attendanceRoute.GET(req(`http://localhost/api/admin/attendance?kind=class&id=${cls.id}`, "GET", deskCookie));
    expect(read.status).toBe(200);
    expect((await read.json()).register).toMatchObject({ phase: "open", canMark: true, canLock: false });
    const post = await attendanceRoute.POST(req("http://localhost/api/admin/attendance", "POST", deskCookie, { kind: "class", id: cls.id, action: "mark", key: `c:${b.id}`, mark: "present" }));
    expect(post.status).toBe(200);
    // Closed for the desk, and the refusals carry their codes.
    const early = await aClass(5);
    const eb = await enrolled(early[0].id);
    const refused = await attendanceRoute.POST(req("http://localhost/api/admin/attendance", "POST", deskCookie, { kind: "class", id: early[0].id, action: "mark", key: `c:${eb.id}`, mark: "present" }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("ATTENDANCE_EARLY");
    const lock = await lockRoute.POST(req("http://localhost/api/admin/attendance/lock", "POST", deskCookie, { kind: "class", id: cls.id, locked: true }));
    expect(lock.status).toBe(403);
    expect((await lock.json()).code).toBe("MANAGER_ONLY");
    expect((await reportRoute.GET(req(`http://localhost/api/admin/attendance/report?venueId=${venueId}&classId=${cls.id}`, "GET", deskCookie))).status).toBe(403);
    expect((await settingsRoute.POST(req("http://localhost/api/admin/lesson-settings", "POST", deskCookie, { venueId, attendanceLockDays: 5 }))).status).toBe(403);
    expect((await lockRoute.POST(req("http://localhost/api/admin/attendance/lock", "POST", managerCookie, { kind: "class", id: cls.id, locked: true }))).status).toBe(200);
    expect((await attendanceRoute.POST(req("http://localhost/api/admin/attendance", "POST", deskCookie, { kind: "class", id: cls.id, action: "mark", key: `c:${b.id}`, mark: "absent" }))).status).toBe(403);
    // Another venue's manager reaches nothing of this venue's.
    for (const res of [
      await attendanceRoute.GET(req(`http://localhost/api/admin/attendance?kind=class&id=${cls.id}`, "GET", otherCookie)),
      await attendanceRoute.POST(req("http://localhost/api/admin/attendance", "POST", otherCookie, { kind: "class", id: cls.id, action: "mark", key: `c:${b.id}`, mark: "present" })),
      await lockRoute.POST(req("http://localhost/api/admin/attendance/lock", "POST", otherCookie, { kind: "class", id: cls.id, locked: false })),
      await reportRoute.GET(req(`http://localhost/api/admin/attendance/report?venueId=${venueId}&classId=${cls.id}`, "GET", otherCookie)),
      await settingsRoute.POST(req("http://localhost/api/admin/lesson-settings", "POST", otherCookie, { venueId, attendanceLockDays: 1 })),
    ])
      expect(res.status).toBe(403);
    expect((await attendanceRoute.GET(req("http://localhost/api/admin/attendance?kind=class&id=0", "GET", managerCookie))).status).toBe(400);
    expect((await attendanceRoute.GET(req("http://localhost/api/admin/attendance?kind=other&id=1", "GET", managerCookie))).status).toBe(400);
    const actions = (await listActivity([venueId])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["attendance.marked", "attendance.locked"]));
  });

  it("sets the two numbers of days, a manager's, whole days within range, and logs it", async () => {
    const res = await settingsRoute.POST(req("http://localhost/api/admin/lesson-settings", "POST", managerCookie, { venueId, moveRefundDays: 5, attendanceLockDays: 10 }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({ moveRefundDays: 5, attendanceLockDays: 10 });
    expect((await settingsRoute.POST(req("http://localhost/api/admin/lesson-settings", "POST", managerCookie, { venueId, moveRefundDays: 61 }))).status).toBe(400);
    expect((await settingsRoute.POST(req("http://localhost/api/admin/lesson-settings", "POST", managerCookie, { venueId, attendanceLockDays: 1.5 }))).status).toBe(400);
    expect(((await (await settingsRoute.GET(req(`http://localhost/api/admin/lesson-settings?venueId=${venueId}`, "GET", deskCookie))).json()) as { settings: unknown }).settings).toEqual({ moveRefundDays: 5, attendanceLockDays: 10 });
    expect((await listActivity([venueId])).some((a) => a.action === "settings.changed" && (a.detail ?? "").includes("moved-lesson refund window 7 → 5"))).toBe(true);
    await settingsRoute.POST(req("http://localhost/api/admin/lesson-settings", "POST", managerCookie, { venueId, moveRefundDays: 7, attendanceLockDays: 14 }));
  });
});

describe("a session's register stays with it when it is moved", () => {
  it("keeps a class's marks when its own time changes in place, and a lesson's when staff move it", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    await mark(desk, { kind: "class", id: cls.id }, `c:${b.id}`, "absent", {}, noonOn(cls.date));
    // The class's time moved (by the class workstream's move, which changes the row in place under the same id).
    await getDb().prepare("UPDATE classes SET date = ?, start_min = ? WHERE id = ?").run(day(6), H(9), cls.id);
    const r = await reg(manager, { kind: "class", id: cls.id }, noonOn(day(6)));
    expect(r.lines[0]).toMatchObject({ mark: "absent" });
    expect(r.session).toMatchObject({ date: day(6), startMin: H(9) });
  });
});

describe("reports and the spreadsheet", () => {
  it("counts per session and per person: the present rate, who has missed several in a row, and the entries left on their passes", async () => {
    const sessions = await aClass(1, { weeks: 4 });
    const a = [] as { id: number }[];
    const mum = await account("Mum");
    const kid = await addManaged(mum.id, { displayName: "Kiki, Child", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error(kid.error);
    // A regular on an account, a child, a guest, a walk-in.
    const regular = await account("Regular");
    for (const s of sessions) {
      const r1 = await enrolPeople({ classId: s.id, name: regular.name, phone: regular.phone, userId: regular.id, people: [null] });
      const r2 = await enrolPeople({ classId: s.id, name: mum.name, phone: mum.phone, userId: mum.id, people: [{ id: kid.person.id, name: kid.person.displayName }] });
      if (!r1.ok || !r2.ok) throw new Error("enrol");
      a.push(...r1.bookings, ...r2.bookings);
    }
    const marks = [
      // regular: present, late, absent, absent  => 2/4 present or late of 4 seen... absent twice in a row at the end
      ["present", "absent"],
      ["late", "excused"],
      ["absent", "present"],
      ["absent", "absent"],
    ] as const;
    for (const [i, s] of sessions.entries()) {
      const now = noonOn(s.date);
      const ref = { kind: "class" as const, id: s.id };
      const [mine, hers] = [a[i * 2], a[i * 2 + 1]];
      await mark(manager, ref, `c:${mine.id}`, marks[i][0], {}, now);
      await mark(manager, ref, `p:${hers.id}:${kid.person.id}`, marks[i][1], {}, now);
    }
    await addWalkIn(manager, { kind: "class", id: sessions[0].id }, { name: "Drop In Dee" }, noonOn(sessions[0].date));
    // The regular holds a pass with entries left; a mark never touches it.
    const pass = await issuePass({ venueId, name: "Regular pass", entries: 10, price: 100, holderName: regular.name, holderPhone: regular.phone, expiresOn: day(60), adminId: adminIds.manager, userId: regular.id });
    expect(pass.ok).toBe(true);
    const report = (await attendanceReport(venueId, { seriesCode: sessions[0].seriesCode! }))!;
    expect(report.sessions).toHaveLength(4);
    // Session one: the regular present, the child absent, and the walk-in.
    expect(report.sessions[0]).toMatchObject({ present: 2, absent: 1 });
    const person = (name: string) => report.people.find((p) => p.name === name)!;
    expect(person(regular.name)).toMatchObject({ present: 1, late: 1, absent: 2, marked: 4, presentRate: 50, missedInARow: 2 });
    // The child: absent, excused, present, absent: the last absence follows a session attended, so one in a row.
    expect(person("Kiki, Child")).toMatchObject({ present: 1, absent: 2, excused: 1, marked: 4, missedInARow: 1 });
    expect(person("Drop In Dee")).toMatchObject({ walkIn: true, present: 1, marked: 1 });
    expect(report.totals.presentRate).not.toBeNull();
    // The most missed come first.
    expect(report.people[0].missedInARow).toBeGreaterThanOrEqual(report.people[1].missedInARow);
    expect(person(regular.name).passEntriesLeft).toBe(10);
    expect(person("Kiki, Child").passEntriesLeft).toBeNull();
    // The report by class: one session; and by dates: classes and lessons together.
    expect((await attendanceReport(venueId, { classId: sessions[0].id }))!.sessions).toHaveLength(1);
    expect((await attendanceReport(venueId, { from: sessions[0].date, to: sessions[3].date }))!.sessions.length).toBeGreaterThanOrEqual(4);
    expect(await attendanceReport(venueId, { classId: 99999999 })).toBeNull();
    // Another venue's class is not in this venue's report.
    expect(await attendanceReport(otherVenueId, { classId: sessions[0].id })).toBeNull();
  });

  it("gives the marks as a spreadsheet with the documented columns, children in full, a formula in a name made harmless, and logs the download", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id, "=HYPERLINK(\"http://evil\")");
    const now = noonOn(cls.date);
    await mark(manager, { kind: "class", id: cls.id }, `c:${b.id}`, "present", { note: "+1 note" }, now);
    const csv = (await attendanceCsv(venueId, { classId: cls.id }))!;
    const [head, row] = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(head).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(","));
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(row).toContain(`"'+1 note"`);
    expect(row).toContain(`"enrolled"`);
    const res = await reportRoute.GET(req(`http://localhost/api/admin/attendance/report?venueId=${venueId}&classId=${cls.id}&format=csv`, "GET", managerCookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await listActivity([venueId])).some((a) => a.action === "attendance.exported")).toBe(true);
    // The JSON report by the route, and what it refuses.
    expect((await (await reportRoute.GET(req(`http://localhost/api/admin/attendance/report?venueId=${venueId}&classId=${cls.id}`, "GET", managerCookie))).json()).report.sessions).toHaveLength(1);
    expect((await reportRoute.GET(req(`http://localhost/api/admin/attendance/report?venueId=${venueId}`, "GET", managerCookie))).status).toBe(400);
    expect((await reportRoute.GET(req(`http://localhost/api/admin/attendance/report?venueId=${venueId}&from=2026-03-02&to=2026-03-01`, "GET", managerCookie))).status).toBe(400);
  });
});

describe("what a customer and a guardian see, and the data they can take", () => {
  it("shows a customer their own marks and a guardian their children's, never the note, never anybody else's", async () => {
    const [cls] = await aClass(1);
    const mum = await account("Mum");
    const kid = await addManaged(mum.id, { displayName: "Lina Hassan", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error(kid.error);
    const stranger = await account("Stranger");
    const made = await enrolPeople({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: [{ id: kid.person.id, name: kid.person.displayName }, null] });
    if (!made.ok) throw new Error("enrol");
    const other = await enrolPeople({ classId: cls.id, name: stranger.name, phone: stranger.phone, userId: stranger.id, people: [null] });
    if (!other.ok) throw new Error("enrol");
    const now = noonOn(cls.date);
    const ref = { kind: "class" as const, id: cls.id };
    const [forKid, forMum] = made.bookings;
    await mark(manager, ref, `p:${forKid.id}:${kid.person.id}`, "late", { note: "Private note about Lina" }, now);
    await mark(manager, ref, `c:${forMum.id}`, "absent", {}, now);
    await mark(manager, ref, `c:${other.bookings[0].id}`, "present", {}, now);
    const mine = await myAttendance(mum.id);
    expect(mine.map((l) => [l.forName, l.mark])).toEqual(expect.arrayContaining([["Lina Hassan", "late"], [null, "absent"]]));
    expect(JSON.stringify(mine)).not.toContain("Private note");
    expect((await myAttendance(stranger.id)).map((l) => [l.forName, l.mark])).toEqual([[null, "present"]]);
    const res = await myAttendanceRoute.GET(req("http://localhost/api/my/attendance", "GET", mum.cookie));
    expect(res.status).toBe(200);
    expect((await res.json()).attendance).toHaveLength(2);
    expect((await myAttendanceRoute.GET(req("http://localhost/api/my/attendance", "GET", null))).status).toBe(401);
    // A guardian who stopped acting for the child sees nothing more of them.
    const mine2 = await account("Other Mum");
    expect(await myAttendance(mine2.id)).toEqual([]);
    // The export carries the marks and the notes held about them, labelled.
    const exported = await attendanceExport(mum.id);
    expect(exported.length).toBe(2);
    expect(JSON.stringify(exported)).toContain("Private note about Lina");
    expect(JSON.stringify((await exportCustomerData(mum.id))!.attendance)).toContain("Lina Hassan");
    expect(JSON.stringify((await exportCustomerData(stranger.id))!.attendance)).not.toContain("Lina");
  });

  it("anonymises a person's marks when their account is erased, kept as counts, and a child's when their record is", async () => {
    const [cls] = await aClass(1);
    const mum = await account("Mum");
    const kid = await addManaged(mum.id, { displayName: "Erased Child", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error(kid.error);
    const lone = await account("Leaver");
    const m = await enrolPeople({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: [{ id: kid.person.id, name: kid.person.displayName }] });
    const l = await enrolPeople({ classId: cls.id, name: lone.name, phone: lone.phone, userId: lone.id, people: [null] });
    if (!m.ok || !l.ok) throw new Error("enrol");
    const now = noonOn(cls.date);
    const ref = { kind: "class" as const, id: cls.id };
    await mark(manager, ref, `p:${m.bookings[0].id}:${kid.person.id}`, "present", { note: "Erased Child's note" }, now);
    await mark(manager, ref, `c:${l.bookings[0].id}`, "absent", { note: "Leaver's note" }, now);
    const before = (await attendanceReport(venueId, { classId: cls.id }))!;
    expect(before.people.map((p) => p.name).sort()).toEqual(["Erased Child", lone.name].sort());
    expect(await eraseCustomer(lone.id)).toMatchObject({ ok: true });
    await eraseParticipant(kid.person.id, "Erased in a test");
    const rows = (await getDb().prepare("SELECT user_id, participant_id, booking_id, note, walk_in_name, anonymised_at, mark FROM attendance_marks WHERE kind = 'class' AND session_id = ?").all(cls.id)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ user_id: null, participant_id: null, booking_id: null, note: null, walk_in_name: null });
    expect(rows.every((r) => r.anonymised_at !== null)).toBe(true);
    expect(rows.map((r) => r.mark).sort()).toEqual(["absent", "present"]);
    // Kept as counts: the session still says one came and one did not, and names nobody.
    const after = (await attendanceReport(venueId, { classId: cls.id }))!;
    expect(after.sessions[0]).toMatchObject({ present: 1, absent: 1 });
    expect(after.people).toEqual([]);
    expect((await attendanceCsv(venueId, { classId: cls.id }))!).not.toContain("note");
    expect(await myAttendance(lone.id)).toEqual([]);
  });

  it("follows the venue's retention schedule: marks go 730 days after the session, with their corrections", async () => {
    const lines = await retentionDue();
    const line = lines.find((x) => x.what === "Attendance marks and their corrections");
    expect(line).toMatchObject({ days: 730, action: "deleted" });
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    await mark(manager, { kind: "class", id: cls.id }, `c:${b.id}`, "present", {}, noonOn(cls.date));
    await mark(manager, { kind: "class", id: cls.id }, `c:${b.id}`, "absent", {}, noonOn(cls.date));
    const db = getDb();
    const count = async () => ((await db.prepare("SELECT COUNT(*)::int AS n FROM attendance_marks WHERE session_id = ? AND kind = 'class'").get(cls.id)) as { n: number }).n;
    expect(await count()).toBe(1);
    // Not yet old enough: kept.
    await db.prepare("UPDATE attendance_marks SET session_date = ? WHERE session_id = ? AND kind = 'class'").run(addDays(todayISO(), -729), cls.id);
    await pruneOldData();
    expect(await count()).toBe(1);
    const mid = ((await db.prepare("SELECT id FROM attendance_marks WHERE session_id = ? AND kind = 'class'").get(cls.id)) as { id: number }).id;
    await db.prepare("UPDATE attendance_marks SET session_date = ? WHERE id = ?").run(addDays(todayISO(), -731), mid);
    await db.prepare("UPDATE attendance_sessions SET session_date = ? WHERE session_id = ? AND kind = 'class'").run(addDays(todayISO(), -731), cls.id);
    await pruneOldData();
    expect(await count()).toBe(0);
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM attendance_changes WHERE mark_id = ?").get(mid)) as { n: number }).n).toBe(0);
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM attendance_sessions WHERE session_id = ? AND kind = 'class'").get(cls.id)) as { n: number }).n).toBe(0);
  });
});

describe("a mark moves no money and changes nothing else", () => {
  it("leaves payments, credit, passes, receipts, strikes, no-show flags and messages as they were, for every mark", async () => {
    const [cls] = await aClass(1);
    const payer = await enrolled(cls.id, "Payer");
    const unpaid = await enrolled(cls.id, "Unpaid");
    expect((await setPaymentStatus(payer.code, true, "cash")).ok).toBe(true);
    const date = day(1);
    const l = await lesson(ana, date, 14);
    await getDb().prepare("UPDATE bookings SET payment_status = 'unpaid' WHERE id = ?").run(l.id);
    const db = getDb();
    const snapshot = async () => ({
      bookings: await db.prepare("SELECT id, status, payment_status, total_price, paid_via, late_cancelled, late_kept_percent, no_show, released_unpaid FROM bookings ORDER BY id").all(),
      wallet: await db.prepare("SELECT id, user_id, amount FROM wallet_entries ORDER BY id").all(),
      passes: await db.prepare("SELECT id, status, entries FROM passes ORDER BY id").all(),
      passEntries: await db.prepare("SELECT id, pass_id, delta FROM pass_entries ORDER BY id").all(),
      receipts: await db.prepare("SELECT id, kind, total FROM receipts ORDER BY id").all(),
      payments: await db.prepare("SELECT id, status, amount, refund_due, refunded FROM online_payments ORDER BY id").all(),
      owed: await db.prepare("SELECT id FROM counter_refunds_owed ORDER BY id").all(),
      messages: await db.prepare("SELECT id FROM messages ORDER BY id").all(),
      strikes: await db.prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE late_cancelled = 1 OR no_show = 1").get(),
      claims: await db.prepare("SELECT id, active FROM claims ORDER BY id").all(),
    });
    const before = await snapshot();
    const now = noonOn(cls.date);
    const lessonNow = noonOn(date);
    for (const m of ["present", "absent", "late", "excused", "absent"]) {
      await mark(manager, { kind: "class", id: cls.id }, `c:${payer.id}`, m, { note: "n" }, now);
      await mark(desk, { kind: "class", id: cls.id }, `c:${unpaid.id}`, m, {}, now);
      await mark(coachViewer(ana), { kind: "lesson", id: l.id }, `c:${l.id}`, m, {}, lessonNow);
    }
    await addWalkIn(manager, { kind: "class", id: cls.id }, { name: "Walk" }, now);
    await lockRegister(manager, { kind: "class", id: cls.id }, true, now);
    await attendanceReport(venueId, { classId: cls.id });
    await attendanceCsv(venueId, { classId: cls.id });
    expect(await snapshot()).toEqual(before);
    // And the booking itself is unchanged on the book: still confirmed, still as paid.
    const [row] = (await listBookingsForDate(cls.date, venueId)).filter((b) => b.code === payer.code);
    expect(row).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  });
});

describe("concurrent writes to one register", () => {
  it("makes one mark when the desk and the manager mark the same person at the same moment, and keeps both as a first mark and a change", async () => {
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    const ref = { kind: "class" as const, id: cls.id };
    const now = noonOn(cls.date);
    const key = `c:${b.id}`;
    const results = await Promise.all([mark(desk, ref, key, "present", {}, now), mark(manager, ref, key, "late", {}, now), mark(desk, ref, key, "absent", {}, now)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = (await getDb().prepare("SELECT mark FROM attendance_marks WHERE kind = 'class' AND session_id = ?").all(cls.id)) as { mark: string }[];
    expect(rows).toHaveLength(1);
    const changes = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM attendance_changes c JOIN attendance_marks m ON m.id = c.mark_id WHERE m.session_id = ? AND m.kind = 'class'").get(cls.id)) as { n: number }).n;
    // One of the three was first; the other two changed it.
    expect(changes).toBe(2);
  });

  it("takes a lock and a desk mark in turns: a mark made after the lock is refused, one made before it stands", async () => {
    for (let round = 0; round < 3; round++) {
      const [cls] = await aClass(1);
      const people = [await enrolled(cls.id), await enrolled(cls.id), await enrolled(cls.id)];
      const ref = { kind: "class" as const, id: cls.id };
      const now = noonOn(cls.date);
      const [lock, ...marks] = await Promise.all([lockRegister(manager, ref, true, now), ...people.map((p) => mark(desk, ref, `c:${p.id}`, "present", {}, now))]);
      expect(lock.ok).toBe(true);
      for (const m of marks) expect(m.ok || m.code === "ATTENDANCE_CLOSED").toBe(true);
      const stored = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM attendance_marks WHERE kind = 'class' AND session_id = ?").get(cls.id)) as { n: number }).n;
      expect(stored).toBe(marks.filter((m) => m.ok).length);
      // Whatever got in, the register is closed to the desk now.
      expect(await mark(desk, ref, `c:${people[0].id}`, "absent", {}, now)).toMatchObject({ ok: false, code: "ATTENDANCE_CLOSED" });
    }
  });
});

describe("a session that is not one", () => {
  it("finds no register for a booking that is not a lesson, nor for a class that does not exist", async () => {
    expect(await sessionInfo({ kind: "lesson", id: 99999999 })).toBeNull();
    expect(await sessionInfo({ kind: "class", id: 99999999 })).toBeNull();
    const [cls] = await aClass(1);
    const b = await enrolled(cls.id);
    // An enrolment is a booking, but not a lesson.
    expect(await sessionInfo({ kind: "lesson", id: b.id })).toBeNull();
    expect(await registerFor(manager, { kind: "lesson", id: b.id })).toMatchObject({ ok: false, code: "ATTENDANCE_NOT_FOUND" });
    expect(adminIds.manager).toBeGreaterThan(0);
  });
});
