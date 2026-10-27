import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { notifyCoaches, setCoachEmail } from "../src/lib/coach-schedule";
import { addTimeOff, retireCoach, saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { createCourt, createVenue, findBooking, rescheduleBooking, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import * as customerReschedule from "../src/app/api/bookings/reschedule/route";
import * as staffReschedule from "../src/app/api/admin/bookings/reschedule/route";

/**
 * Moving a one-to-one lesson to another time (lib/store.ts rescheduleBooking;
 * docs/features/programmes.md#one-to-one-coaching): through the booking's own
 * reschedule path, its coach moving with it — the coach's hours, time off and
 * other lessons checked, and their time claimed with the court's in one
 * transaction under the constraint that keeps a coach in one lesson at a
 * time — or, staff choosing, to another coach while nothing is paid. The
 * customer and staff both; the coach told.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const H = (h: number) => h * 60;
let n = 0;
let venueId: number;
let ana: Coach;
let ben: Coach;
let cara: Coach;
let swimCoach: Coach;
let managerCookie: string;
let deskCookie: string;

const ip = () => `198.51.${++n % 250}.${n % 200}`;
/** A lesson booked online, an hour, unpaid: its code and the pupil's phone. */
async function lesson(coach: Coach, date: string, hour: number, minutes = 60) {
  const phone = `01288${String(++n).padStart(5, "0")}`;
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ venueId, sport: "tennis", date, start: H(hour), end: H(hour) + minutes, name: `Pupil ${n}`, phone, coachId: coach.id }),
    })
  );
  const body = await res.json();
  if (res.status !== 201) throw new Error(JSON.stringify(body));
  return { code: body.booking.code as string, phone, id: body.booking.id as number };
}
const tryLesson = (coach: Coach, date: string, hour: number) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ venueId, sport: "tennis", date, start: H(hour), end: H(hour + 1), name: `Rival ${++n}`, phone: `01299${String(n).padStart(5, "0")}`, coachId: coach.id }),
    })
  );
const customerMove = (b: { code: string; phone: string }, date: string, hour: number) =>
  customerReschedule.POST(
    new NextRequest("http://localhost/api/bookings/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ code: b.code, phone: b.phone, date, start: H(hour) }),
    })
  );
const customerOptions = async (b: { code: string; phone: string }, date: string) =>
  (await (
    await customerReschedule.GET(
      new NextRequest(`http://localhost/api/bookings/reschedule?code=${b.code}&phone=${b.phone}&date=${date}`, { headers: { "x-forwarded-for": ip() } })
    )
  ).json()) as { options: { startMin: number; difference: number }[] };
const staffMove = (cookie: string, body: Record<string, unknown>) =>
  staffReschedule.POST(
    new NextRequest("http://localhost/api/admin/bookings/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    })
  );
const staffOptions = async (code: string, date: string, coachId?: number) =>
  (await (
    await staffReschedule.GET(
      new NextRequest(`http://localhost/api/admin/bookings/reschedule?code=${code}&date=${date}${coachId ? `&coachId=${coachId}` : ""}`, { headers: { cookie: managerCookie } })
    )
  ).json()) as { options: { startMin: number; difference: number }[] };

/** The coach's live claims, as [coach, start minute of the day] pairs, for one booking. */
const coachHeld = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT coach_id, lower(during) AS lo FROM coach_claims WHERE booking_id = ? AND active")
    .all(bookingId)) as { coach_id: number; lo: Date }[];
const startsAt = (date: string, hour: number) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`).getTime();

beforeAll(async () => {
  const made = await createVenue({ name: "Lesson Club", area: "Bangsar", address: "1 Jalan Pindah", phone: "0322224444" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  for (const name of ["Court 1", "Court 2"]) {
    const c = await createCourt({ venueId, name, sport: "tennis", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
  }
  await createCourt({ venueId, name: "Pool", sport: "swimming", offPeakRate: 10, peakRate: 10 });
  const hours = (from: number, until: number) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: H(from), until: H(until) }));
  const save = async (name: string, rate: number, sport: string, from = 8, until = 20) => {
    const s = await saveCoach(venueId, { name, sports: [sport], rate, hours: hours(from, until) });
    if (!s.ok) throw new Error(s.error);
    return s.coach;
  };
  ana = await save("Ana Lim", 80, "tennis");
  ben = await save("Ben Tan", 100, "tennis");
  cara = await save("Cara Ong", 60, "tennis");
  swimCoach = await save("Sam Swim", 50, "swimming");
  for (const [k, email] of [
    [ana, "ana@coach.test"],
    [ben, "ben@coach.test"],
  ] as const)
    expect((await setCoachEmail(k.id, venueId, email)).ok).toBe(true);
  const staff = async (name: string, role: "manager" | "desk") => {
    const a = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@lessons.test`, password: "a long enough password", venueId, role });
    if (!a.ok) throw new Error(a.error);
    return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}`;
  };
  managerCookie = await staff("Mei Manager", "manager");
  deskCookie = await staff("Dino Desk", "desk");
});

describe("a customer moving their lesson", () => {
  it("moves it with its coach: the court and the coach's time both move, the price stays, nothing is left behind", async () => {
    const date = day(4);
    const l = await lesson(ana, date, 10);
    // Ana has another lesson at 12, and stops at 20:00.
    await lesson(ana, date, 12);
    const { options } = await customerOptions(l, date);
    const starts = options.map((o) => o.startMin);
    expect(starts).toContain(H(9));
    expect(starts).toContain(H(13));
    expect(starts).not.toContain(H(10)); // where it is now
    expect(starts).not.toContain(H(12)); // her other lesson
    expect(starts).not.toContain(H(20)); // she has stopped by then
    expect(options.every((o) => o.difference === 0)).toBe(true);

    const res = await customerMove(l, date, 13);
    expect(res.status).toBe(200);
    expect((await res.json()).booking).toMatchObject({ startMin: H(13), coachId: ana.id, coachFee: 80, totalPrice: 100 });
    const held = await coachHeld(l.id);
    expect(held).toHaveLength(1);
    expect(held[0].coach_id).toBe(ana.id);
    expect(new Date(held[0].lo).getTime()).toBe(startsAt(date, 13));
    // The old hour is free for Ana again.
    expect((await tryLesson(ana, date, 10)).status).toBe(201);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("is refused where the coach is not working, on time off, or already teaching; and past the venue's notice", async () => {
    const date = day(5);
    const l = await lesson(ana, date, 9);
    await lesson(ana, date, 15);
    expect(await (await customerMove(l, date, 20)).json()).toMatchObject({ code: "COACH_NOT_WORKING" });
    expect(await (await customerMove(l, date, 15)).json()).toMatchObject({ code: "COACH_TAKEN" });
    const off = day(6);
    expect((await addTimeOff(ana.id, { from: off, until: off, reason: "Tournament" })).ok).toBe(true);
    expect(await (await customerMove(l, off, 10)).json()).toMatchObject({ code: "COACH_NOT_WORKING" });
    expect((await customerOptions(l, off)).options).toEqual([]);
    // Nothing moved: still at 9, Ana still held then.
    expect(await findBooking(l.code, l.phone)).toMatchObject({ startMin: H(9), coachId: ana.id });
    expect(new Date((await coachHeld(l.id))[0].lo).getTime()).toBe(startsAt(date, 9));
    // The venue's notice: changes close as cancelling does.
    const soon = await lesson(ana, day(1), 11);
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 72 WHERE id = ?").run(venueId);
    expect(await (await customerMove(soon, day(1), 12)).json()).toMatchObject({ code: "RESCHEDULE_CUTOFF" });
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 0 WHERE id = ?").run(venueId);
  });
});

describe("staff moving a lesson", () => {
  it("front desk moves it with its coach; a manager's override passes the court's rules but never the coach's hours", async () => {
    const date = day(7);
    const l = await lesson(ana, date, 10);
    const moved = await staffMove(deskCookie, { code: l.code, date, start: H(11) });
    expect(moved.status).toBe(200);
    expect((await moved.json()).booking).toMatchObject({ startMin: H(11), coachId: ana.id });
    const late = await staffMove(managerCookie, { code: l.code, date, start: H(21), override: true });
    expect(await late.json()).toMatchObject({ code: "COACH_NOT_WORKING" });
  });

  it("gives an unpaid lesson to another coach: their hours and lessons decide the times, their fee the price, both coaches told", async () => {
    const date = day(8);
    const l = await lesson(ana, date, 10);
    // Ana has heard of it.
    await notifyCoaches();
    await lesson(ben, date, 14);
    const forBen = (await staffOptions(l.code, date, ben.id)).options;
    expect(forBen.map((o) => o.startMin)).toContain(H(10)); // the same time, with Ben
    expect(forBen.map((o) => o.startMin)).not.toContain(H(14)); // Ben's other lesson
    expect(forBen.find((o) => o.startMin === H(10))?.difference).toBe(20); // Ben's 100 for Ana's 80
    // Preview first, changing nothing.
    const seen = await staffMove(managerCookie, { code: l.code, date, start: H(10), coachId: ben.id, preview: true });
    expect(seen.status).toBe(200);
    expect((await seen.json()).preview).toMatchObject({ priceChange: 20 });
    expect(await findBooking(l.code, l.phone)).toMatchObject({ coachId: ana.id });

    const res = await staffMove(managerCookie, { code: l.code, date, start: H(11), coachId: ben.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking).toMatchObject({ startMin: H(11), coachId: ben.id, coachFee: 100, totalPrice: 120 });
    expect(body.priceChange).toBe(20);
    expect((await coachHeld(l.id)).map((c) => c.coach_id)).toEqual([ben.id]);
    // Ana is free at 10 again; Ben is held at 11.
    expect((await tryLesson(ana, date, 10)).status).toBe(201);
    expect(await (await tryLesson(ben, date, 11)).json()).toMatchObject({ code: "COACH_TAKEN" });
    const mails = (await getDb()
      .prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'coach_lesson' AND booking_id = ? ORDER BY id")
      .all(l.id)) as { recipient: string; subject: string; body: string }[];
    expect(mails.map((m) => m.recipient)).toEqual(["ana@coach.test", "ben@coach.test", "ana@coach.test"]);
    expect(mails[1].body).toContain("a lesson has been booked with you");
    expect(mails[2].subject).toContain("No longer yours");
    expect(mails[2].body).toContain("now with another coach");
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE booking_code = ? AND action = 'booking.rescheduled'").all(l.code)) as { detail: string }[];
    expect(logged.at(-1)?.detail).toContain("lesson with Ben Tan");
    expect(await checkIntegrity()).toEqual([]);
  });

  it("keeps a paid lesson's coach, and refuses a retired coach or one for another sport", async () => {
    const date = day(9);
    const l = await lesson(ana, date, 10);
    expect(await (await staffMove(managerCookie, { code: l.code, date, start: H(11), coachId: swimCoach.id })).json()).toMatchObject({ code: "COACH_NOT_FOUND" });
    expect(await retireCoach(cara.id, venueId)).toBe(true);
    expect(await (await staffMove(managerCookie, { code: l.code, date, start: H(11), coachId: cara.id })).json()).toMatchObject({ code: "COACH_NOT_FOUND" });
    expect((await staffOptions(l.code, date, cara.id)).options).toEqual([]);
    await setPaymentStatus(l.code, true, "cash");
    expect(await (await staffMove(managerCookie, { code: l.code, date, start: H(11), coachId: ben.id })).json()).toMatchObject({ code: "RESCHEDULE_COACH_PAID" });
    // Paid, with its own coach: moved, keeping what was paid.
    const same = await staffMove(managerCookie, { code: l.code, date, start: H(11) });
    expect(same.status).toBe(200);
    expect((await same.json()).booking).toMatchObject({ startMin: H(11), coachId: ana.id, totalPrice: 100, paymentStatus: "paid" });
  });

  it("tells the coach the old time and the new, once the coach knew of it", async () => {
    const date = day(10);
    const l = await lesson(ana, date, 9);
    // Not yet told of it: the move adds nothing; the scheduler tells Ana of the lesson at its time now.
    expect((await staffMove(managerCookie, { code: l.code, date, start: H(10) })).status).toBe(200);
    const count = async () =>
      ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'coach_lesson' AND booking_id = ?").get(l.id)) as { n: number }).n;
    expect(await count()).toBe(0);
    await notifyCoaches();
    expect(await count()).toBe(1);
    expect((await customerMove(l, date, 11)).status).toBe(200);
    const last = (await getDb()
      .prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'coach_lesson' AND booking_id = ? ORDER BY id DESC LIMIT 1")
      .get(l.id)) as { recipient: string; subject: string; body: string };
    expect(last.recipient).toBe("ana@coach.test");
    expect(last.subject).toContain("Moved");
    expect(last.body).toContain(`has moved from ${date}, 10:00`);
    expect(last.body).toContain("11:00");
  });

  it("a customer cannot choose another coach", async () => {
    const date = day(11);
    const l = await lesson(ana, date, 9);
    expect(await rescheduleBooking(l.code, { date, start: H(10), coachId: ben.id }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_COACH" });
  });
});

describe("at the same moment as another booking for the coach's time", () => {
  it("a move and a new lesson for the same coach and hour: exactly one gets it", async () => {
    for (let round = 0; round < 4; round++) {
      const date = day([2, 3, 12, 13][round]);
      const l = await lesson(ana, date, 9);
      const [moved, rival] = await Promise.all([
        rescheduleBooking(l.code, { date, start: H(16) }, "customer"),
        tryLesson(ana, date, 16),
      ]);
      const rivalWon = rival.status === 201;
      expect(moved.ok !== rivalWon).toBe(true);
      if (!moved.ok) expect(moved.code).toBe("COACH_TAKEN");
      else expect(await rival.json()).toMatchObject({ code: "COACH_TAKEN" });
      const held = (await getDb()
        .prepare("SELECT COUNT(*)::int AS n FROM coach_claims WHERE coach_id = ? AND active AND during && tstzrange(?::timestamptz, ?::timestamptz)")
        .get(ana.id, new Date(startsAt(date, 16)).toISOString(), new Date(startsAt(date, 17)).toISOString())) as { n: number };
      expect(held.n).toBe(1);
      // The loser left nothing behind: the lesson where it was, or no stray booking.
      if (!moved.ok) expect(new Date((await coachHeld(l.id))[0].lo).getTime()).toBe(startsAt(date, 9));
    }
    expect(await checkIntegrity()).toEqual([]);
  });

  it("two lessons moved onto the same coach's hour: one moves, the other stays", async () => {
    const date = day(3);
    const a = await lesson(ana, date, 11);
    const b = await lesson(ana, date, 13);
    const results = await Promise.all([
      rescheduleBooking(a.code, { date, start: H(18) }, "staff"),
      rescheduleBooking(b.code, { date, start: H(18) }, "staff"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "COACH_TAKEN" });
    expect(await checkIntegrity()).toEqual([]);
  });
});
