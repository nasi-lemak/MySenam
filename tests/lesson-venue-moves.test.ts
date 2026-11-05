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
import { markAttendance, staffViewer } from "../src/lib/attendance";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { coachCalendar, coachForToken, coachLessons, notifyCoaches, setCoachEmail, setCoachLink } from "../src/lib/coach-schedule";
import { saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { adjustBookingPrice } from "../src/lib/price-adjustments";
import { lessonMoveHistory, openLessonMove, cancelMovedLesson } from "../src/lib/lesson-venue-moves";
import { notifyReminders } from "../src/lib/notify";
import { checkIntegrity } from "../src/lib/integrity";
import { pruneOldData, retentionDue } from "../src/lib/privacy";
import { adminCancelBooking, createBooking, createCourt, createVenue, findBooking, getBookingById, getWalletBalance, rescheduleBooking, setPaymentStatus, topUpWallet } from "../src/lib/store";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { POST as book, GET as lookup } from "../src/app/api/bookings/route";
import * as customerReschedule from "../src/app/api/bookings/reschedule/route";
import * as staffReschedule from "../src/app/api/admin/bookings/reschedule/route";
import * as cancelMoved from "../src/app/api/bookings/cancel-moved/route";
import * as myCancelMoved from "../src/app/api/my/bookings/cancel-moved/route";

/**
 * A coached lesson's time moved by staff (lib/lesson-venue-moves.ts; docs/features/programmes.md#a-lesson-moved-by-the-venue): through the
 * booking's own staff "change time", the coach's week and other lessons and the court checked; the agreed price stays whatever the new
 * time costs; the customer told and offered everything back for a while, their own act; the coach told, the calendar and link showing the
 * new time; reminders re-armed; a lesson already started or attended not moved.
 */

const ZONE = "Asia/Kuala_Lumpur";
const H = (h: number) => h * 60;
let n = 0;
let venueId: number;
let ana: Coach;
let ben: Coach;
let managerCookie: string;
let deskCookie: string;
let managerId: number;

/** The k-th weekday from today: 10:00 is off-peak and 19:00 peak on it. */
function weekday(k: number): string {
  let d = todayISO(ZONE);
  for (let found = 0; found < k; ) {
    d = addDays(d, 1);
    if (!isPeakMinute(d, H(10)) && isPeakMinute(d, H(19))) found++;
  }
  return d;
}
const phone = () => `01266${String(++n).padStart(5, "0")}`;
const ip = () => `198.18.${++n % 250}.${n % 200}`;
async function lesson(coach: Coach, date: string, hour: number, extra: Record<string, unknown> = {}, cookie?: string) {
  const who = { name: `Pupil ${++n}`, phone: phone(), email: `pupil${n}@lessons.test` };
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ venueId, sport: "tennis", date, start: H(hour), end: H(hour + 1), ...who, coachId: coach.id, ...extra }),
    })
  );
  const body = await res.json();
  if (res.status !== 201) throw new Error(JSON.stringify(body));
  return { code: body.booking.code as string, id: body.booking.id as number, ...who };
}
const staffMove = (cookie: string, body: Record<string, unknown>) =>
  staffReschedule.POST(new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
const messages = async (bookingId: number, kind?: string) =>
  (await getDb()
    .prepare(`SELECT kind, channel, locale, subject, body, params, status, dedupe_key FROM messages WHERE booking_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY id`)
    .all(...(kind ? [bookingId, kind] : [bookingId]))) as { kind: string; channel: string; locale: string; subject: string; body: string; params: string | null; status: string; dedupe_key: string | null }[];
const cancelBy = (b: { code: string; phone: string }) =>
  cancelMoved.POST(new NextRequest("http://localhost/api/bookings/cancel-moved", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ code: b.code, phone: b.phone }) }));

beforeAll(async () => {
  const made = await createVenue({ name: "Moved Lesson Club", area: "Bangsar", address: "1 Jalan Pindah", phone: "0322223333" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  // Lessons are booked weeks ahead here, and customers move them within the same window.
  await getDb().prepare("UPDATE venues SET book_ahead_days = 60 WHERE id = ?").run(venueId);
  for (const name of ["Court 1", "Court 2"]) {
    const c = await createCourt({ venueId, name, sport: "tennis", offPeakRate: 20, peakRate: 40 });
    if (!c.ok) throw new Error("court");
  }
  const hours = (from: number, until: number) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: H(from), until: H(until) }));
  const save = async (name: string, from = 8, until = 21) => {
    const s = await saveCoach(venueId, { name, sports: ["tennis"], rate: 80, hours: hours(from, until) });
    if (!s.ok) throw new Error(s.error);
    return s.coach;
  };
  ana = await save("Ana Lim");
  ben = await save("Ben Tan", 8, 14);
  expect((await setCoachEmail(ana.id, venueId, "ana@coach.test")).ok).toBe(true);
  const staff = async (name: string, role: "manager" | "desk") => {
    const a = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@moved.test`, password: "a long enough password", venueId, role });
    if (!a.ok) throw new Error(a.error);
    return { id: a.admin.id, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}` };
  };
  const m = await staff("Mei Manager", "manager");
  managerId = m.id;
  managerCookie = m.cookie;
  deskCookie = (await staff("Dino Desk", "desk")).cookie;
});

describe("moving a lesson: the coach's week, other lessons and the court", () => {
  it("is refused when the coach has another lesson then, is not working then, or every court is taken; the lesson stays where it was", async () => {
    const date = weekday(1);
    const mine = await lesson(ana, date, 10);
    await lesson(ana, date, 12);
    // The coach is in another lesson at 12:00; the lesson stays at 10:00.
    const clash = await staffMove(deskCookie, { code: mine.code, date, start: H(12) });
    expect(clash.status).toBe(409);
    expect((await clash.json()).code).toBe("COACH_TAKEN");
    // Ben takes lessons only until 14:00.
    const benLesson = await lesson(ben, date, 9);
    const off = await staffMove(managerCookie, { code: benLesson.code, date, start: H(15) });
    expect((await off.json()).code).toBe("COACH_NOT_WORKING");
    // Both courts taken at 16:00 by others: the court's claims refuse it.
    const courts = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ? AND sport = 'tennis' ORDER BY id").all(venueId)) as { id: number }[];
    for (const c of courts) {
      const taken = await createBooking({ courtId: c.id, date, hours: [16], name: "Somebody Else", phone: phone() });
      expect(taken.ok).toBe(true);
    }
    const full = await staffMove(deskCookie, { code: mine.code, date, start: H(16) });
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe("RESCHEDULE_TAKEN");
    expect((await findBooking(mine.code, mine.phone))!).toMatchObject({ date, startMin: H(10) });
    expect(await openLessonMove((await findBooking(mine.code, mine.phone))!.id)).toBeNull();
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM lesson_moves").get()) as { n: number }).toMatchObject({ n: 0 });
  });

  it("moves it to a free time with its coach, the court and the coach's time both moving, and records it with before and after", async () => {
    const date = weekday(2);
    const l = await lesson(ana, date, 10);
    const to = weekday(3);
    const res = await staffMove(deskCookie, { code: l.code, date: to, start: H(11) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking).toMatchObject({ date: to, startMin: H(11), coachId: ana.id });
    const claim = (await getDb().prepare("SELECT lower(during) AS lo FROM coach_claims WHERE booking_id = ? AND active").all(l.id)) as { lo: Date }[];
    expect(claim).toHaveLength(1);
    expect(claim[0].lo.getTime()).toBe(new Date(`${to}T11:00:00+08:00`).getTime());
    const moves = await lessonMoveHistory(l.id);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: { date, startMin: H(10) }, to: { date: to, startMin: H(11) }, movedBy: "Dino Desk", cancelledAt: null });
    const log = (await listActivity([venueId])).find((a) => a.action === "booking.rescheduled" && a.bookingCode === l.code)!;
    expect(log.adminName).toBe("Dino Desk");
    expect(log.detail).toContain(`${date} 10:00 AM → ${to} 11:00 AM`);
    expect(await checkIntegrity([venueId])).toEqual([]);
  });

  it("is not done to a lesson that has started, nor to one somebody was marked present at", async () => {
    const date = weekday(4);
    const attended = await lesson(ana, date, 10);
    const marked = await markAttendance(staffViewer({ id: managerId, name: "Mei Manager", role: "manager" }), { kind: "lesson", id: attended.id }, { key: `c:${attended.id}`, mark: "present" });
    expect(marked.ok).toBe(true);
    const res = await staffMove(managerCookie, { code: attended.code, date, start: H(13) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LESSON_ATTENDED");
    // Absent is not attended: it moves.
    const absent = await lesson(ana, date, 14);
    await markAttendance(staffViewer({ id: managerId, name: "Mei Manager", role: "manager" }), { kind: "lesson", id: absent.id }, { key: `c:${absent.id}`, mark: "absent" });
    expect((await staffMove(managerCookie, { code: absent.code, date, start: H(15) })).status).toBe(200);
    // A lesson already under way: its start has passed.
    const nowMin = Math.round((Date.now() - new Date(`${todayISO(ZONE)}T00:00:00+08:00`).getTime()) / 60_000);
    if (nowMin > 40 && nowMin < H(24) - 40) {
      const today = await lesson(ana, weekday(30), 10);
      await getDb()
        .prepare("UPDATE bookings SET date = ?, start_min = ?, end_min = ?, starts_at = ?, ends_at = ? WHERE id = ?")
        .run(todayISO(ZONE), nowMin - 30, nowMin + 30, new Date(Date.now() - 30 * 60_000).toISOString(), new Date(Date.now() + 30 * 60_000).toISOString(), today.id);
      const started = await staffMove(managerCookie, { code: today.code, date: addDays(todayISO(ZONE), 2), start: H(10) });
      expect(started.status).toBe(409);
      expect((await started.json()).code).toBe("LESSON_STARTED");
      // The stand-in is called off through the booking's own path, so its claims go with it.
      expect((await adminCancelBooking(today.code)).ok).toBe(true);
    }
  });
});

describe("the price stays as agreed", () => {
  it("keeps it whatever the new time costs, unpaid or paid, shows the difference first, and leaves changing it to a manager's logged adjustment", async () => {
    const date = weekday(5);
    const unpaid = await lesson(ana, date, 10);
    const paid = await lesson(ana, date, 12);
    expect((await setPaymentStatus(paid.code, true, "cash")).ok).toBe(true);
    // 19:00 is a peak hour: the court there costs 20 more.
    const seen = await staffMove(deskCookie, { code: unpaid.code, date, start: H(19), preview: true });
    expect(seen.status).toBe(200);
    expect((await seen.json()).preview).toMatchObject({ keepsAgreedPrice: true, priceChange: 0, unchargedDifference: 20 });
    expect((await getBookingById(unpaid.id))!).toMatchObject({ startMin: H(10), totalPrice: 100 });
    const moved = await staffMove(deskCookie, { code: unpaid.code, date, start: H(19) });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ priceChange: 0, unchargedDifference: 20, booking: { totalPrice: 100, startMin: H(19) } });
    const logged = (await listActivity([venueId])).find((a) => a.action === "booking.rescheduled" && a.bookingCode === unpaid.code)!;
    expect(logged.detail).toContain("lesson keeps the price agreed, the new time costs");
    const movedPaid = await staffMove(deskCookie, { code: paid.code, date, start: H(20) });
    expect(await movedPaid.json()).toMatchObject({ priceChange: 0, unchargedDifference: 20, booking: { totalPrice: 100, paymentStatus: "paid" } });
    expect((await lessonMoveHistory(unpaid.id))[0].priceDifference).toBe(20);
    // And a cheaper time is not given back.
    const back = await staffMove(deskCookie, { code: unpaid.code, date, start: H(9) });
    expect(await back.json()).toMatchObject({ priceChange: 0, unchargedDifference: -20, booking: { totalPrice: 100 } });
    // Only a manager changes the price, as a logged adjustment of its own; the desk is refused.
    const asked = await adjustBookingPrice({ code: unpaid.code, amount: 120, reason: "Peak hour, agreed with the parent", staff: { id: managerId, name: "Mei Manager", role: "manager" } });
    expect(asked.ok).toBe(true);
    expect((await getBookingById(unpaid.id))!.totalPrice).toBe(120);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM booking_price_adjustments WHERE booking_id = ?").get(unpaid.id)) as { n: number }).n).toBe(1);
  });

  it("still reprices a lesson its customer moves themselves, as any booking is, and a court booking staff move as before", async () => {
    const date = weekday(6);
    const l = await lesson(ana, date, 10);
    const res = await customerReschedule.POST(
      new NextRequest("http://localhost/api/bookings/reschedule", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ code: l.code, phone: l.phone, date, start: H(19) }) })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).booking).toMatchObject({ totalPrice: 120, startMin: H(19) });
    // A customer's move is not the venue's: no window to cancel because of it.
    expect(await lessonMoveHistory(l.id)).toHaveLength(0);
    const court = await rescheduleBooking(l.code, { date, start: H(10) }, "customer");
    expect(court).toMatchObject({ ok: true, priceChange: -20 });
  });
});

describe("telling the customer and the coach, and the new time everywhere", () => {
  it("tells the customer the new time, that the price stays and that they may cancel for everything back, in their language; the coach too", async () => {
    const date = weekday(7);
    const l = await lesson(ana, date, 10, { locale: "ms" });
    await getDb().prepare("UPDATE bookings SET locale = 'ms' WHERE id = ?").run(l.id);
    await notifyCoaches();
    const heard = (await messages(l.id, "coach_lesson")).length;
    expect(heard).toBe(1);
    const to = weekday(8);
    expect((await staffMove(deskCookie, { code: l.code, date: to, start: H(11) })).status).toBe(200);
    const notice = (await messages(l.id, "booking_rescheduled")).find((m) => m.channel === "email")!;
    expect(notice.locale).toBe("ms");
    const params = JSON.parse(notice.params ?? "{}") as Record<string, string>;
    // The sentence added to the usual one: until when, and the booking's own link.
    expect(params.money).toContain("Pusat telah mengubah pelajaran ini");
    expect(params.money).toMatch(/\/my-booking\?code=.*&t=/);
    expect(notice.body).toContain("Pusat telah mengubah pelajaran ini");
    // The coach hears the old time and the new.
    const coachMsgs = await messages(l.id, "coach_lesson");
    expect(coachMsgs).toHaveLength(2);
    expect(coachMsgs[1].subject).toContain("Moved: lesson now on");
    expect(coachMsgs[1].body).toContain(date);
  });

  it("shows the new time on the coach's link and in their calendar feed, and on the customer's booking page with the offer", async () => {
    const date = weekday(9);
    const l = await lesson(ana, date, 10);
    const to = weekday(10);
    expect((await staffMove(managerCookie, { code: l.code, date: to, start: H(16) })).status).toBe(200);
    const link = await setCoachLink(ana.id, venueId, true);
    const found = (await coachForToken(link!.link!.pageUrl.split("/coach/")[1]))!;
    const lessons = await coachLessons(ana.id, to, to);
    expect(lessons.find((x) => x.code === l.code)).toMatchObject({ date: to, startHour: 16 });
    expect((await coachLessons(ana.id, date, date)).some((x) => x.code === l.code)).toBe(false);
    const ics = await coachCalendar(found, venueId);
    expect(ics).toContain(`UID:lesson-${l.code}@`);
    expect(ics).toContain(`DTSTART:${to.replace(/-/g, "")}T080000Z`);
    // The customer's own page shows where it was and is, and until when they may cancel with everything back.
    const page = await lookup(new NextRequest(`http://localhost/api/bookings?code=${l.code}&phone=${l.phone}`, { headers: { "x-forwarded-for": ip() } }));
    const data = await page.json();
    expect(data.movedLesson).toMatchObject({ from: { date, startMin: H(10) }, to: { date: to, startMin: H(16) }, priceDifference: 0 });
    expect(new Date(data.movedLesson.until).getTime()).toBeGreaterThan(Date.now());
  });

  it("re-arms the reminders: one queued for the old time is given up, and one already sent no longer blocks the new time's", async () => {
    const date = weekday(11);
    const l = await lesson(ana, date, 10);
    const db = getDb();
    // Made well before, so its reminder is due once its time is within a day.
    await db.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").run(`${addDays(todayISO(), -10)} 09:00:00`, l.id);
    await db.prepare("INSERT INTO messages (booking_id, venue_id, kind, channel, recipient, body, status, dedupe_key) VALUES (?, ?, 'booking_reminder', 'email', 'a@b.test', 'old reminder', 'sent', ?)").run(l.id, venueId, `reminder:${l.code}`);
    await db.prepare("INSERT INTO messages (booking_id, venue_id, kind, channel, recipient, body, status, dedupe_key) VALUES (?, ?, 'booking_reminder', 'whatsapp', '60123', 'queued reminder', 'queued', ?)").run(l.id, venueId, `reminder:${l.code}:whatsapp`);
    const to = weekday(12);
    expect((await staffMove(deskCookie, { code: l.code, date: to, start: H(14) })).status).toBe(200);
    const rows = await messages(l.id, "booking_reminder");
    expect(rows.find((r) => r.body === "queued reminder")!.status).toBe("abandoned");
    expect(rows.every((r) => !(r.dedupe_key ?? "").endsWith(`reminder:${l.code}`))).toBe(true);
    // Within a day of the new time, the reminder is for the new time and goes once.
    const nearNew = new Date(new Date(`${to}T14:00:00+08:00`).getTime() - 20 * 3_600_000);
    expect(await notifyReminders(nearNew)).toBeGreaterThanOrEqual(1);
    const after = (await messages(l.id, "booking_reminder")).filter((r) => r.dedupe_key === `reminder:${l.code}`);
    expect(after).toHaveLength(1);
    expect(after[0].body).toContain("2:00 PM to 3:00 PM");
    expect(await notifyReminders(nearNew)).toBe(0);
  });
});

describe("cancelling because the venue moved it", () => {
  it("is the customer's own act: nothing is refunded for them, and the offer lasts the venue's days, or until the old time if sooner", async () => {
    const date = weekday(13);
    const l = await lesson(ana, date, 10);
    expect(await openLessonMove(l.id)).toBeNull();
    const to = weekday(14);
    const before = Date.now();
    await staffMove(deskCookie, { code: l.code, date: to, start: H(10) });
    const offer = (await openLessonMove(l.id))!;
    // Seven days by default; the lesson's old time is further away than that here, so the seven days decide.
    const days = (new Date(offer.until).getTime() - before) / 86_400_000;
    const oldStart = new Date(`${date}T10:00:00+08:00`).getTime();
    const expected = Math.min(7, (oldStart - before) / 86_400_000);
    expect(days).toBeGreaterThan(expected - 0.01);
    expect(days).toBeLessThanOrEqual(expected + 0.01);
    // Still booked, nothing refunded, until they say so.
    expect((await getBookingById(l.id))!.status).toBe("confirmed");
    // Moved again: the window is the latest move's.
    await staffMove(deskCookie, { code: l.code, date: to, start: H(12) });
    expect((await lessonMoveHistory(l.id))).toHaveLength(2);
    expect((await openLessonMove(l.id))!.from).toMatchObject({ startMin: H(10) });
  });

  it("ends at the old time when that is sooner than the venue's days, and a venue that sets none offers none", async () => {
    const soon = addDays(todayISO(ZONE), 2);
    const l = await lesson(ana, soon, 20);
    await staffMove(deskCookie, { code: l.code, date: addDays(todayISO(ZONE), 3), start: H(9) });
    const offer = (await openLessonMove(l.id))!;
    expect(new Date(offer.until).getTime()).toBe(new Date(`${soon}T20:00:00+08:00`).getTime());
    await getDb().prepare("UPDATE venues SET lesson_move_refund_days = 0 WHERE id = ?").run(venueId);
    try {
      const none = await lesson(ana, weekday(15), 10);
      await staffMove(deskCookie, { code: none.code, date: weekday(16), start: H(10) });
      expect(await openLessonMove(none.id)).toBeNull();
      const res = await cancelBy(none);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("LESSON_MOVE_NO_OFFER");
    } finally {
      await getDb().prepare("UPDATE venues SET lesson_move_refund_days = 7 WHERE id = ?").run(venueId);
    }
  });

  it("gives everything back to the credit it was paid from, with no late share and no strike, and the coach hears of the cancellation", async () => {
    const made = await registerUser({ name: "Credit Pupil", email: "credit@moved.test", phone: phone(), password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const cookie = `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}`;
    await topUpWallet({ userId: made.user.id, amount: 200, adminId: managerId, venueId });
    const date = weekday(17);
    const l = await lesson(ana, date, 10, { payFromWallet: true, name: made.user.name, phone: made.user.phone }, cookie);
    // The coach had heard of it, so hears of its cancellation.
    await notifyCoaches();
    expect(await getWalletBalance(made.user.id, venueId)).toBe(100);
    // Moved to within the cancellation cutoff of the old rules would not matter: the venue moved it.
    await staffMove(deskCookie, { code: l.code, date: weekday(18), start: H(10) });
    const res = await myCancelMoved.POST(new NextRequest("http://localhost/api/my/bookings/cancel-moved", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ bookingId: l.id }) }));
    expect(res.status).toBe(200);
    expect(await getWalletBalance(made.user.id, venueId)).toBe(200);
    const row = (await getDb().prepare("SELECT status, late_cancelled, late_kept_percent FROM bookings WHERE id = ?").get(l.id)) as { status: string; late_cancelled: number; late_kept_percent: number | null };
    expect(row).toMatchObject({ status: "cancelled", late_cancelled: 0 });
    expect((await lessonMoveHistory(l.id))[0].cancelledAt).not.toBeNull();
    expect(await openLessonMove(l.id)).toBeNull();
    // Again: already cancelled, and nothing more is credited.
    const again = await myCancelMoved.POST(new NextRequest("http://localhost/api/my/bookings/cancel-moved", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ bookingId: l.id }) }));
    expect(again.status).toBe(409);
    expect(await getWalletBalance(made.user.id, venueId)).toBe(200);
    // Somebody else's booking is not theirs to cancel.
    const other = await registerUser({ name: "Other Pupil", email: "other@moved.test", phone: phone(), password: "a long enough password" });
    if (!other.ok) throw new Error(other.error);
    const stranger = await myCancelMoved.POST(
      new NextRequest("http://localhost/api/my/bookings/cancel-moved", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${(await createSession(other.user.id)).token}` }, body: JSON.stringify({ bookingId: l.id }) })
    );
    expect(stranger.status).toBe(404);
    await notifyCoaches();
    expect((await messages(l.id, "coach_lesson")).some((m) => /cancel/i.test(m.subject))).toBe(true);
    expect(await checkIntegrity([venueId])).toEqual([]);
  });

  it("owes a counter payment back for the desk to hand over, as for any lesson the venue cancels", async () => {
    const l = await lesson(ana, weekday(19), 10);
    expect((await setPaymentStatus(l.code, true, "cash")).ok).toBe(true);
    await staffMove(deskCookie, { code: l.code, date: weekday(20), start: H(10) });
    const res = await cancelBy(l);
    expect(res.status).toBe(200);
    const owed = (await getDb().prepare("SELECT amount::float AS amount, cause, settled_at FROM counter_refunds_owed WHERE booking_id = ?").all(l.id)) as { amount: number; cause: string; settled_at: unknown }[];
    expect(owed).toEqual([{ amount: 100, cause: "lesson_moved", settled_at: null }]);
  });

  it("is refused for a lesson the venue did not move, after the window, once the lesson has started, and for the wrong phone number", async () => {
    const fresh = await lesson(ana, weekday(21), 10);
    const none = await cancelBy(fresh);
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe("LESSON_MOVE_NO_OFFER");
    const moved = await lesson(ana, weekday(22), 10);
    await staffMove(deskCookie, { code: moved.code, date: weekday(23), start: H(10) });
    const wrong = await cancelMoved.POST(new NextRequest("http://localhost/api/bookings/cancel-moved", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ code: moved.code, phone: "0100000000" }) }));
    expect(wrong.status).toBe(404);
    // Past the window: the booking's ordinary terms apply.
    await getDb().prepare("UPDATE lesson_moves SET window_ends_at = now() - interval '1 minute' WHERE booking_id = ?").run(moved.id);
    const late = await cancelBy(moved);
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("LESSON_MOVE_NO_OFFER");
    expect((await getBookingById(moved.id))!.status).toBe("confirmed");
    // A booking that is not a lesson has no offer.
    const book2 = (await getBookingById(moved.id))!;
    expect(await cancelMovedLesson({ ...book2, coachId: null })).toMatchObject({ ok: false, code: "LESSON_MOVE_NO_OFFER" });
  });

  it("is taken once when two customers' taps arrive together", async () => {
    const l = await lesson(ana, weekday(24), 10);
    await staffMove(deskCookie, { code: l.code, date: weekday(25), start: H(10) });
    const [a, b] = await Promise.all([cancelBy(l), cancelBy(l)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE booking_id = ?").get(l.id)) as { n: number }).toMatchObject({ n: 0 });
  });
});

describe("the record of a move follows the venue's retention schedule", () => {
  it("goes 730 days after the move, and not before", async () => {
    const l = await lesson(ana, weekday(28), 10);
    await staffMove(deskCookie, { code: l.code, date: weekday(29), start: H(10) });
    const db = getDb();
    const count = async () => ((await db.prepare("SELECT COUNT(*)::int AS n FROM lesson_moves WHERE booking_id = ?").get(l.id)) as { n: number }).n;
    expect(await count()).toBe(1);
    await db.prepare("UPDATE lesson_moves SET moved_at = now() - interval '729 days' WHERE booking_id = ?").run(l.id);
    await pruneOldData();
    expect(await count()).toBe(1);
    await db.prepare("UPDATE lesson_moves SET moved_at = now() - interval '731 days' WHERE booking_id = ?").run(l.id);
    await pruneOldData();
    expect(await count()).toBe(0);
    expect((await retentionDue()).some((x) => x.what === "Records of lessons the venue moved")).toBe(true);
  });
});

describe("a series of lessons moved together", () => {
  it("records each week's move, and the customer's one notice carries the offer to cancel", async () => {
    const made = await registerUser({ name: "Series Pupil", email: "series@moved.test", phone: phone(), password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const cookie = `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}`;
    const first = await lesson(ana, weekday(27), 10, { weeks: 2, name: made.user.name, phone: made.user.phone }, cookie);
    const rows = (await getDb().prepare("SELECT id, code, series_code FROM bookings WHERE series_code = (SELECT series_code FROM bookings WHERE id = ?) ORDER BY date").all(first.id)) as { id: number; code: string; series_code: string }[];
    expect(rows).toHaveLength(2);
    const { POST } = await import("../src/app/api/admin/bookings/move-series/route");
    const res = await POST(
      new NextRequest("http://localhost/api/admin/bookings/move-series", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: managerCookie },
        body: JSON.stringify({ seriesCode: rows[0].series_code, start: H(15) }),
      })
    );
    expect(res.status).toBe(200);
    for (const r of rows) {
      expect((await getBookingById(r.id))!.startMin).toBe(H(15));
      expect(await openLessonMove(r.id)).not.toBeNull();
    }
    const notice = (await messages(rows[0].id, "booking_rescheduled")).find((m) => m.channel === "email")!;
    expect(notice.body).toContain("you can cancel it for everything back until");
  });
});
