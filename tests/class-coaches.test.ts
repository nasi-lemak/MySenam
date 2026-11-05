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
import { changeClass } from "../src/lib/class-changes";
import { classCoachConflicts, coachClasses, coachMatching } from "../src/lib/class-coaches";
import { moveClasses } from "../src/lib/class-moves";
import { coachCalendar, coachForToken, setCoachLink } from "../src/lib/coach-schedule";
import { staffCalendar } from "../src/lib/staff-calendar";
import { addTimeOff, attachCoach, coachById, retireCoach, saveCoach, setCoachHours, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { cancelClassAndTell } from "../src/lib/notify";
import { createBooking, createClassSessions, createCourt, enrolInClass, getClass, joinClassWaitlist, listClasses, listVenues, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as adminClasses, POST as adminSchedule } from "../src/app/api/admin/classes/route";
import { PATCH as adminChange } from "../src/app/api/admin/classes/[id]/route";
import { GET as attention } from "../src/app/api/admin/attention/route";
import { GET as publicClasses } from "../src/app/api/classes/route";

/**
 * A class's instructor as one of the venue's coaches (lib/class-coaches.ts): checked and held like a lesson's coach, in one
 * session at a time, on the coach's schedule and calendar, kept when the coach cannot teach it any more and said on the worklist.
 */

let venueId: number;
let managerCookie: string;
let seq = 0;
let tennisCourt: { id: number };
let coach: Coach;
const day = (n: number) => addDays(todayISO(), n);
const everyDay = (from: number, until: number) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from, until }));

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const manager = await createAdmin({ name: "Mona Coach", email: "mona-cc@venue.my", password: "manager-pass-1", venueId });
  if (!manager.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  const studio = await createCourt({ venueId, name: "Coach Studio", sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
  const tennis = await createCourt({ venueId, name: "Coach Tennis", sport: "tennis", offPeakRate: 20, peakRate: 20 });
  if (!studio.ok || !tennis.ok) throw new Error("court");
  tennisCourt = tennis.court;
  coach = await newCoach("Ana Lim", ["gym", "tennis"]);
});

async function newCoach(name: string, sports = ["gym"], hours = everyDay(8 * 60, 20 * 60)): Promise<Coach> {
  const saved = await saveCoach(venueId, { name: `${name} ${++seq}`, sports, rate: 60, hours });
  if (!saved.ok) throw new Error(saved.error);
  return saved.coach;
}

async function aStudio() {
  const made = await createCourt({ venueId, name: `Coach Room ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
  if (!made.ok) throw new Error("court");
  return made.court;
}

const schedule = async (input: Partial<Parameters<typeof createClassSessions>[0]> & { courtId?: number } = {}) =>
  createClassSessions({
    courtId: input.courtId ?? (await aStudio()).id,
    name: `Strength ${++seq}`,
    instructor: "typed name",
    date: day(5),
    startHour: 10,
    endHour: 11,
    capacity: 5,
    price: 10,
    ...input,
  });

const claimsOf = async (classId: number) => (await getDb().prepare("SELECT COUNT(*)::int AS n FROM coach_claims WHERE class_id = ? AND active").get(classId)) as { n: number };

async function lesson(coachRow: Coach, date: string, hour: number, courtId?: number) {
  // A court of its own each time: only the coach is what the lessons and classes share.
  const own = courtId ?? ((await createCourt({ venueId, name: `Coach Tennis ${++seq}`, sport: "tennis", offPeakRate: 20, peakRate: 20 })) as { ok: true; court: { id: number } }).court.id;
  const made = await createBooking({ courtId: own, date, hours: [hour], name: "Pupil", phone: `01277${String(++seq).padStart(6, "0")}`, sport: "tennis" });
  if (!made.ok) throw new Error(made.error);
  return { made, attached: await attachCoach(made.booking.id, coachRow) };
}

describe("a coach as a class's instructor", () => {
  it("holds the coach for each session and shows their own name to customers, never a contact", async () => {
    const made = await schedule({ coachId: coach.id, weeks: 2 });
    if (!made.ok) throw new Error(made.error);
    for (const c of made.classes) {
      expect(c).toMatchObject({ coachId: coach.id, instructor: coach.name });
      expect(await claimsOf(c.id)).toEqual({ n: 1 });
    }
    // The coach's own name is what the venue's public classes list says; nothing of how to reach them.
    const res = await publicClasses(new NextRequest(`http://localhost/api/classes?venueId=${venueId}`));
    const text = JSON.stringify(await res.json());
    expect(text).toContain(coach.name);
    expect(text).not.toMatch(/email|phone|bio/i);
    // A renamed coach is the instructor under the new name.
    await saveCoach(venueId, { id: coach.id, name: `${coach.name} Tan`, sports: ["gym", "tennis"], rate: 60, hours: everyDay(8 * 60, 20 * 60) });
    expect((await getClass(made.classes[0].id))!.instructor).toBe(`${coach.name} Tan`);
    await saveCoach(venueId, { id: coach.id, name: coach.name, sports: ["gym", "tennis"], rate: 60, hours: everyDay(8 * 60, 20 * 60) });
  });

  it("is a coach of this venue, active, who coaches the activity and works then", async () => {
    const elsewhere = await createVenue({ name: "Coach Elsewhere", area: "Ampang", address: "1 Jalan Lain", phone: "0388880000" });
    if (!elsewhere.ok) throw new Error("venue");
    const theirs = await saveCoach(elsewhere.venue.id, { name: "Other Venue Coach", sports: ["gym"], rate: 10, hours: everyDay(0, 1440 - 1) });
    if (!theirs.ok) throw new Error(theirs.error);
    expect(await schedule({ coachId: theirs.coach.id, date: day(6) })).toMatchObject({ ok: false, code: "COACH_NOT_FOUND" });
    expect(await schedule({ coachId: 999999, date: day(6) })).toMatchObject({ ok: false, code: "COACH_NOT_FOUND" });
    const tennisOnly = await newCoach("Tennis Only", ["tennis"]);
    expect(await schedule({ coachId: tennisOnly.id, date: day(6) })).toMatchObject({ ok: false, code: "CLSA_COACH_SPORT" });
    const late = await newCoach("Morning Coach", ["gym"], everyDay(8 * 60, 12 * 60));
    expect(await schedule({ coachId: late.id, date: day(6), startHour: 18, endHour: 19 })).toMatchObject({ ok: false, code: "COACH_NOT_WORKING" });
    await addTimeOff(late.id, { from: day(7), until: day(7) });
    expect(await schedule({ coachId: late.id, date: day(7) })).toMatchObject({ ok: false, code: "COACH_NOT_WORKING" });
    await addTimeOff(late.id, { from: day(13), until: day(13) });
    const gone = await newCoach("Retired Coach");
    await retireCoach(gone.id, venueId);
    expect(await schedule({ coachId: gone.id, date: day(6) })).toMatchObject({ ok: false, code: "COACH_NOT_FOUND" });
    // Refused, nothing was made: no half-made series.
    expect(await schedule({ coachId: late.id, date: day(6), weeks: 3, startHour: 11, endHour: 12 })).toMatchObject({ ok: false });
    expect((await listClasses({ venueId })).some((c) => c.coachId === late.id)).toBe(false);
  });

  it("is never in a lesson and a class, or two classes, at once, both ways round", async () => {
    const c = await newCoach("Busy Coach", ["gym", "tennis"]);
    const first = await schedule({ coachId: c.id, date: day(8), startHour: 10, endHour: 11 });
    if (!first.ok) throw new Error(first.error);
    // Another class, on another room, overlapping by a minute.
    const room = await aStudio();
    const clash = await schedule({ coachId: c.id, courtId: room.id, date: day(8), startHour: 10.5, endHour: 11.5 });
    expect(clash).toMatchObject({ ok: false, code: "CLSA_COACH_CLASS", vars: { name: c.name, class: first.classes[0].name, date: day(8) } });
    // A lesson over the class: the coach is taken.
    const over = await lesson(c, day(8), 10);
    expect(over.attached).toMatchObject({ ok: false, code: "COACH_TAKEN" });
    // A lesson, then a class over it: refused, said as a lesson.
    const own = await lesson(c, day(9), 14);
    expect(own.attached.ok).toBe(true);
    expect(await schedule({ coachId: c.id, date: day(9), startHour: 14, endHour: 15 })).toMatchObject({ ok: false, code: "CLSA_COACH_LESSON" });
    // Back to back is fine.
    expect(await schedule({ coachId: c.id, date: day(9), startHour: 15, endHour: 16 })).toMatchObject({ ok: true });
  });

  it("a lesson and a class asked for at one moment: one gets the coach", async () => {
    const c = await newCoach("Race Coach", ["gym", "tennis"]);
    const made = await createBooking({ courtId: tennisCourt.id, date: day(10), hours: [16], name: "Racer", phone: "0128880016", sport: "tennis" });
    if (!made.ok) throw new Error(made.error);
    const [l, k] = await Promise.all([attachCoach(made.booking.id, c), schedule({ coachId: c.id, date: day(10), startHour: 16, endHour: 17 })]);
    expect([l.ok, k.ok].filter(Boolean)).toHaveLength(1);
  });

  it("a called-off class lets the coach go", async () => {
    const c = await newCoach("Freed Coach", ["gym", "tennis"]);
    const made = await schedule({ coachId: c.id, date: day(11), startHour: 12, endHour: 13 });
    if (!made.ok) throw new Error(made.error);
    expect((await lesson(c, day(11), 12)).attached.ok).toBe(false);
    expect((await cancelClassAndTell(made.classes[0].id)).ok).toBe(true);
    expect((await lesson(c, day(11), 12, (await createCourt({ venueId, name: `Spare ${++seq}`, sport: "tennis", offPeakRate: 1, peakRate: 1 }) as { ok: true; court: { id: number } }).court.id)).attached.ok).toBe(true);
  });
});

describe("changing the instructor (and the one-click link)", () => {
  it("links a coach for the session or the rest of the series, checked for each, all or none", async () => {
    const made = await schedule({ weeks: 3, date: day(4), startHour: 9, endHour: 10 });
    if (!made.ok) throw new Error(made.error);
    const c = await newCoach("Linked Coach", ["gym", "tennis"]);
    // The coach has a lesson in week two: the whole change is refused, every week stays a name only.
    expect((await lesson(c, made.classes[1].date, 9)).attached.ok).toBe(true);
    const refused = await changeClass(made.classes[0].id, { coachId: c.id, series: true });
    expect(refused).toMatchObject({ ok: false, code: "CLSA_COACH_LESSON" });
    for (const s of made.classes) expect((await getClass(s.id))!).toMatchObject({ coachId: null, instructor: "typed name" });
    // Week one alone goes through, and the coach is held for it.
    expect(await changeClass(made.classes[0].id, { coachId: c.id })).toMatchObject({ ok: true });
    expect((await getClass(made.classes[0].id))!).toMatchObject({ coachId: c.id, instructor: c.name });
    expect(await claimsOf(made.classes[0].id)).toEqual({ n: 1 });
    expect((await getClass(made.classes[2].id))!.coachId).toBeNull();
    // Week two cannot; week three can.
    expect(await changeClass(made.classes[1].id, { coachId: c.id })).toMatchObject({ ok: false, code: "CLSA_COACH_LESSON" });
    expect(await changeClass(made.classes[2].id, { coachId: c.id })).toMatchObject({ ok: true });
    // Made a name only again, it keeps the coach's name as typed and lets the coach go.
    expect(await changeClass(made.classes[2].id, { coachId: null })).toMatchObject({ ok: true });
    expect(await claimsOf(made.classes[2].id)).toEqual({ n: 0 });
    expect((await getClass(made.classes[2].id))!).toMatchObject({ coachId: null, instructor: c.name });
  });

  it("a typed instructor name makes it a name only; the coach's own name changes nothing", async () => {
    const c = await newCoach("Typed Coach", ["gym"]);
    const made = await schedule({ coachId: c.id, date: day(16) });
    if (!made.ok) throw new Error(made.error);
    expect(await changeClass(made.classes[0].id, { instructor: c.name })).toMatchObject({ ok: false, error: "Nothing to change." });
    expect(await changeClass(made.classes[0].id, { instructor: "Guest Instructor" })).toMatchObject({ ok: true });
    expect((await getClass(made.classes[0].id))!).toMatchObject({ coachId: null, instructor: "Guest Instructor" });
    expect(await claimsOf(made.classes[0].id)).toEqual({ n: 0 });
  });

  it("the route changes it for a manager, tells those enrolled the new instructor, and offers a link where a coach's name matches", async () => {
    const c = await newCoach("Match Coach", ["gym", "tennis"]);
    const made = await schedule({ instructor: c.name, date: day(9) });
    if (!made.ok) throw new Error(made.error);
    const [session] = made.classes;
    const enrolled = await enrolInClass({ classId: session.id, name: "Eva Enrolled", phone: "0129990017", email: "eva-cc@coach.my" });
    if (!enrolled.ok) throw new Error(enrolled.error);
    expect(await coachMatching(venueId, c.name)).toEqual({ id: c.id, name: c.name });
    expect(await coachMatching(venueId, "Nobody Known")).toBeNull();
    const list = await adminClasses(new NextRequest(`http://localhost/api/admin/classes?venueId=${venueId}`, { headers: { cookie: managerCookie } }));
    const listed = await list.json();
    expect(listed.coachMatches[session.id]).toEqual({ id: c.id, name: c.name });
    // One click: linked, nobody told (the name read the same), the class held for the coach.
    const res = await adminChange(
      new NextRequest(`http://localhost/api/admin/classes/${session.id}`, { method: "PATCH", headers: { cookie: managerCookie }, body: JSON.stringify({ coachId: c.id }) }),
      { params: Promise.resolve({ id: String(session.id) }) }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).told).toBe(0);
    expect((await getClass(session.id))!.coachId).toBe(c.id);
    const entry = (await listActivity([venueId])).find((a) => a.action === "class.changed" && a.detail?.includes("venue's coach"));
    expect(entry?.detail).toContain(c.name);
    // Another coach: those enrolled are told the instructor is now somebody else.
    const other = await newCoach("Other Coach", ["gym"]);
    const swapped = await changeClass(session.id, { coachId: other.id });
    expect(swapped).toMatchObject({ ok: true, told: 1 });
    const mail = (await getDb().prepare("SELECT body FROM messages WHERE recipient = 'eva-cc@coach.my' AND kind = 'class_changed' ORDER BY id DESC").get()) as { body: string };
    expect(mail.body).toContain(`Its instructor is now ${other.name} (it was ${c.name}).`);
    expect(await claimsOf(session.id)).toEqual({ n: 1 });
    // The first coach is free again for that time.
    expect((await lesson(c, day(9), 10)).attached.ok).toBe(true);
    // A new class takes a coach through the route too, a coach of another venue refused.
    const post = await adminSchedule(
      new NextRequest("http://localhost/api/admin/classes", {
        method: "POST",
        headers: { cookie: managerCookie },
        body: JSON.stringify({ courtId: (await aStudio()).id, name: "Via route", coachId: c.id, date: day(10), start: 13 * 60, end: 14 * 60, capacity: 4, price: 5 }),
      })
    );
    expect(post.status).toBe(201);
    expect((await post.json()).classes[0]).toMatchObject({ coachId: c.id, instructor: c.name });
  });
});

describe("moving a class that has a coach", () => {
  it("checks the coach at the new time, and the coach's hold goes with the class", async () => {
    const c = await newCoach("Moving Coach", ["gym", "tennis"]);
    const made = await schedule({ coachId: c.id, date: day(8), startHour: 10, endHour: 11 });
    if (!made.ok) throw new Error(made.error);
    const [session] = made.classes;
    expect((await lesson(c, day(9), 15)).attached.ok).toBe(true);
    const admin = { id: null, name: "Mover" };
    // Onto the coach's lesson: refused, said as a lesson.
    expect(await moveClasses(admin, session.id, { date: day(9), start: 15 * 60 })).toMatchObject({ ok: false, code: "CLSA_COACH_LESSON" });
    // Outside their hours.
    expect(await moveClasses(admin, session.id, { date: day(9), start: 21 * 60 })).toMatchObject({ ok: false, code: "COACH_NOT_WORKING" });
    expect(await claimsOf(session.id)).toEqual({ n: 1 });
    // A free time: the coach's old time is theirs for a lesson again, the new one is not.
    expect(await moveClasses(admin, session.id, { date: day(9), start: 11 * 60 })).toMatchObject({ ok: true });
    expect((await lesson(c, day(8), 10)).attached.ok).toBe(true);
    expect((await lesson(c, day(9), 11)).attached.ok).toBe(false);
  });

  it("the term: a series moved a week onto its own old times keeps the coach held for each", async () => {
    const c = await newCoach("Term Coach", ["gym"]);
    const made = await schedule({ coachId: c.id, weeks: 3, date: day(22), startHour: 9, endHour: 10 });
    if (!made.ok) throw new Error(made.error);
    const result = await moveClasses({ id: null, name: "Mover" }, made.classes[0].id, { date: day(29), start: 9 * 60 }, "term");
    expect(result.ok).toBe(true);
    for (const s of made.classes) expect(await claimsOf(s.id)).toEqual({ n: 1 });
    const spans = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM coach_claims WHERE coach_id = ? AND active").get(c.id)) as { n: number };
    expect(spans.n).toBe(3);
  });
});

describe("a coach who cannot teach it any more", () => {
  it("is on the worklist with why, the class keeping its instructor", async () => {
    const c = await newCoach("Fading Coach", ["gym"]);
    const made = await schedule({ coachId: c.id, weeks: 3, date: day(30), startHour: 10, endHour: 11 });
    if (!made.ok) throw new Error(made.error);
    const mine = async () => (await classCoachConflicts([venueId])).filter((x) => x.coachId === c.id);
    expect(await mine()).toEqual([]);
    // Days off over week two; the hours changed so that the other weeks are outside them.
    await addTimeOff(c.id, { from: day(37), until: day(37) });
    await setCoachHours(c.id, [{ weekday: new Date(`${day(30)}T00:00:00Z`).getUTCDay(), from: 14 * 60, until: 18 * 60 }]);
    const afterHours = await mine();
    expect(afterHours.map((x) => [x.classId, x.reasons])).toEqual([
      [made.classes[0].id, ["outside_hours"]],
      [made.classes[1].id, ["time_off"]],
      [made.classes[2].id, ["outside_hours"]],
    ]);
    await retireCoach(c.id, venueId);
    const retired = await mine();
    expect(retired.map((x) => x.classId)).toEqual(made.classes.map((s) => s.id));
    expect(retired.every((x) => x.reasons.includes("inactive"))).toBe(true);
    // Nothing was dropped: each class still has the coach and the instructor's name.
    for (const s of made.classes) expect((await getClass(s.id))!).toMatchObject({ coachId: c.id, instructor: c.name });
    // The dashboard's attention list says so, and a class of another venue's would not show.
    const res = await attention(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: managerCookie } }));
    const body = await res.json();
    expect(body.classCoachConflicts.filter((x: { coachId: number }) => x.coachId === c.id)).toHaveLength(3);
    // The class page of classes carries the same.
    const list = await adminClasses(new NextRequest(`http://localhost/api/admin/classes?venueId=${venueId}`, { headers: { cookie: managerCookie } }));
    expect((await list.json()).coachConflicts.filter((x: { coachId: number }) => x.coachId === c.id)).toHaveLength(3);
    // Giving the class another coach clears it.
    const other = await newCoach("Cover Coach", ["gym"]);
    expect(await changeClass(made.classes[0].id, { coachId: other.id, series: true })).toMatchObject({ ok: true });
    expect(await mine()).toEqual([]);
  });
});

describe("on the coach's schedule and calendar", () => {
  it("lists the classes they teach with the places taken, never who is in them", async () => {
    const c = await newCoach("Schedule Coach", ["gym"]);
    const made = await schedule({ coachId: c.id, date: day(3), startHour: 18, endHour: 19, capacity: 4 });
    if (!made.ok) throw new Error(made.error);
    const [session] = made.classes;
    const who = await enrolInClass({ classId: session.id, name: "Secret Student", phone: "0127770099" });
    if (!who.ok) throw new Error(who.error);
    await joinClassWaitlist({ classId: session.id, name: "Waiting Wen", phone: "0127770098" }).catch(() => null);
    const upcoming = await coachClasses(c.id, day(0), day(30));
    expect(upcoming).toEqual([expect.objectContaining({ id: session.id, name: session.name, court: expect.stringContaining("Coach Room"), enrolled: 1, capacity: 4, startMin: 18 * 60 })]);
    const link = await setCoachLink(c.id, venueId, true);
    const token = link!.link!.pageUrl.split("/coach/")[1];
    const found = (await coachForToken(token))!;
    const feed = await coachCalendar(found, venueId, "en");
    expect(feed).toContain(`UID:class-${session.id}@`);
    expect(feed).toContain(`SUMMARY:Class: ${session.name}\\, ${session.courtName}`);
    expect(feed).toContain("1 of 4 places taken");
    expect(feed).not.toContain("Secret Student");
    expect(feed).not.toContain("0127770099");
    // The venue's own staff feed names the coach as the instructor.
    expect(await staffCalendar(venueId, "en")).toContain(c.name);
    // A coach with no class, and one whose class is called off, show nothing.
    await cancelClassAndTell(session.id);
    expect(await coachClasses(c.id, day(0), day(30))).toEqual([]);
    expect(await coachCalendar(found, venueId, "ms")).not.toContain(`UID:class-${session.id}@`);
    expect((await coachById(c.id))!.id).toBe(c.id);
  });
});
