import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import crypto from "crypto";
import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { coachCalendar, coachContacts, coachForToken, coachPayouts, coachPayoutsCsv, LINK_DAYS, notifyCoaches, setCoachEmail, setCoachLink } from "../src/lib/coach-schedule";
import { saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, issuePass, payBookingWithPass } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * Coaching, round two: packs of lessons, lessons every week, a coach's own
 * schedule and emails, and what each coach is owed.
 */

let venueId: number;
let otherVenueId: number;
let coach: Coach;
let other: Coach;
let adminId: number;
let cookie: string;
const start = addDays(todayISO(), 2);
let n = 0;

const post = (body: Record<string, unknown>, withCookie = cookie) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}`, cookie: withCookie },
      body: JSON.stringify({ venueId, sport: "tennis", name: "Pupil Tan", phone: "0123456700", ...body }),
    })
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Coach Hall", area: "PJ", address: "1 Jalan Ajar", phone: "0311110000" });
  const elsewhere = await createVenue({ name: "Elsewhere", area: "PJ", address: "x", phone: "0311110001" });
  if (!made.ok || !elsewhere.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenueId = elsewhere.venue.id;
  for (const name of ["Court 1", "Court 2"]) await createCourt({ venueId, name, sport: "tennis", offPeakRate: 20, peakRate: 20 });
  await createCourt({ venueId: otherVenueId, name: "C", sport: "tennis", offPeakRate: 20, peakRate: 20 });
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 20 * 60 }));
  const a = await saveCoach(venueId, { name: "Ana Lim", sports: ["tennis"], rate: 80, hours });
  const b = await saveCoach(otherVenueId, { name: "Ben", sports: ["tennis"], rate: 50, hours });
  if (!a.ok || !b.ok) throw new Error("coach");
  coach = a.coach;
  other = b.coach;
  const admin = await createAdmin({ name: "Mgr", email: "mgr@coachhall.my", password: "long enough password", venueId });
  if (!admin.ok) throw new Error(admin.error);
  adminId = admin.admin.id;
  const user = await registerUser({ name: "Pupil Tan", email: "pupil@example.my", phone: "0123456700", password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  cookie = `${SESSION_COOKIE}=${(await createSession(user.user.id)).token}`;
});

describe("weekly lessons", () => {
  it("book the coach every week for a signed-in customer, skipping weeks the coach is taken", async () => {
    // Somebody else has Ana in the second week.
    const taken = await post({ date: addDays(start, 7), hours: [10], coachId: coach.id, name: "Someone", phone: "0129999999" }, "");
    expect(taken.status).toBe(201);
    const refused = await post({ date: start, hours: [10], coachId: coach.id, weeks: 3 });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const res = await post({ date: start, hours: [10], coachId: coach.id, weeks: 3, skipConflicts: true });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.bookings.map((b: { date: string }) => b.date)).toEqual([start, addDays(start, 14)]);
    expect(data.bookings.every((b: { coachId: number; totalPrice: number }) => b.coachId === coach.id && b.totalPrice === 100)).toBe(true);
    // Skipped for the court or for the coach, whichever was taken first.
    expect(data.skipped.map((s: { date: string }) => s.date)).toEqual([addDays(start, 7)]);
  });

  it("still need an account", async () => {
    const res = await post({ date: addDays(start, 1), hours: [11], coachId: coach.id, weeks: 2 }, "");
    expect((await res.json()).code).toBe("SERIES_NEEDS_ACCOUNT");
  });
});

describe("a pack of lessons", () => {
  it("is sold for one of the venue's coaches only", async () => {
    const base = { venueId, name: "5 lessons with Ana", entries: 5, price: 450, holderName: "Pupil Tan", holderPhone: "0123456700", expiresOn: addDays(todayISO(), 60), adminId };
    expect(await issuePass({ ...base, coachId: other.id })).toMatchObject({ ok: false });
    const sold = await issuePass({ ...base, coachId: coach.id });
    expect(sold).toMatchObject({ ok: true, pass: { coachId: coach.id, coachName: "Ana Lim", entries: 5 } });
  });

  it("pays a whole lesson with its coach, and nothing else; a court pass pays no lesson", async () => {
    const pack = await issuePass({ venueId, name: "Pack", entries: 5, price: 450, holderName: "Pupil Tan", holderPhone: "0123456700", expiresOn: addDays(todayISO(), 60), adminId, coachId: coach.id });
    const court = await issuePass({ venueId, name: "Court pass", entries: 5, price: 80, holderName: "Pupil Tan", holderPhone: "0123456700", expiresOn: addDays(todayISO(), 60), adminId });
    if (!pack.ok || !court.ok) throw new Error("passes");
    const lesson = await (await post({ date: addDays(start, 2), hours: [12], coachId: coach.id })).json();
    expect(await payBookingWithPass(lesson.booking.id, court.pass.code)).toMatchObject({ ok: false });
    expect(await payBookingWithPass(lesson.booking.id, pack.pass.code)).toMatchObject({ ok: true, spent: 1 });
    const plain = await createBooking({ courtId: lesson.booking.courtId, date: addDays(start, 2), hours: [15], name: "Pupil Tan", phone: "0123456700" });
    if (!plain.ok) throw new Error(plain.error);
    expect(await payBookingWithPass(plain.booking.id, pack.pass.code)).toMatchObject({ ok: false });
    expect(await payBookingWithPass(plain.booking.id, court.pass.code)).toMatchObject({ ok: true });
  });
});

describe("a coach's own schedule", () => {
  it("is at a private link and in a calendar feed, until withdrawn", async () => {
    const made = (await setCoachLink(coach.id, venueId, true))!.link!;
    const token = made.pageUrl.split("/coach/")[1];
    expect(made.calendarUrl).toContain(`/api/coach-calendar/${token}.ics`);
    // Shown once: the venue's list says until when it works, never the link.
    expect((await coachContacts(venueId)).get(coach.id)).toMatchObject({ linkUntil: made.until });
    expect(JSON.stringify(Object.fromEntries(await coachContacts(venueId)))).not.toContain(token);
    const found = (await coachForToken(token))!;
    expect(found.coach.name).toBe("Ana Lim");
    const ics = await coachCalendar(found, venueId);
    expect(ics).toContain("SUMMARY:Lesson: Pupil Tan\\, Court");
    expect(ics).toContain("0123456700");
    expect(await setCoachLink(coach.id, venueId, false)).toEqual({ link: null });
    expect(await coachForToken(token)).toBeNull();
    expect((await coachContacts(venueId)).get(coach.id)!.linkUntil).toBeNull();
    expect(await setCoachLink(999999, venueId, true)).toBeNull();
  });

  it("keeps only the link's hash, and stops working once it lapses or another is made", async () => {
    const first = (await setCoachLink(coach.id, venueId, true))!.link!;
    const token = first.pageUrl.split("/coach/")[1];
    const row = (await getDb().prepare("SELECT calendar_token, link_hash FROM coaches WHERE id = ?").get(coach.id)) as { calendar_token: string | null; link_hash: string };
    expect(row.calendar_token).toBeNull();
    expect(row.link_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(row.link_hash).not.toContain(token);
    expect(new Date(first.until).getTime() - Date.now()).toBeGreaterThan((LINK_DAYS - 1) * 86_400_000);
    // Lapsed: refused, though the hash is still there.
    await getDb().prepare("UPDATE coaches SET link_expires_at = now() - interval '1 minute' WHERE id = ?").run(coach.id);
    expect(await coachForToken(token)).toBeNull();
    expect((await coachContacts(venueId)).get(coach.id)!.linkUntil).toBeNull();
    // A new one replaces it; the old one stays dead.
    const second = (await setCoachLink(coach.id, venueId, true))!.link!;
    expect(await coachForToken(token)).toBeNull();
    expect((await coachForToken(second.pageUrl.split("/coach/")[1]))!.coach.id).toBe(coach.id);
  });

  it("emails the coach of lessons booked and cancelled, once each", async () => {
    expect(await setCoachEmail(coach.id, venueId, "not-an-email")).toMatchObject({ ok: false });
    await setCoachEmail(coach.id, venueId, "ana@coach.my");
    const first = await notifyCoaches();
    expect(first).toBeGreaterThan(0);
    expect(await notifyCoaches()).toBe(0);
    const sent = (await getDb().prepare("SELECT subject FROM messages WHERE kind = 'coach_lesson' AND recipient = 'ana@coach.my'").all()) as { subject: string }[];
    expect(sent[0].subject).toMatch(/^New lesson: /);
    const one = (await getDb().prepare("SELECT id FROM bookings WHERE coach_id = ? AND status = 'confirmed' ORDER BY id LIMIT 1").get(coach.id)) as { id: number };
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(one.id);
    expect(await notifyCoaches()).toBe(1);
    expect(await notifyCoaches()).toBe(0);
    const cancelled = (await getDb().prepare("SELECT body FROM messages WHERE dedupe_key = ?").get(`coach-cancel:${one.id}`)) as { body: string };
    expect(cancelled.body).toContain("has been cancelled");
  });
});

describe("what a coach is owed", () => {
  it("is their fee on lessons that went ahead, paid and not yet, with no-shows apart", async () => {
    const lessons = (await getDb().prepare("SELECT id, payment_status FROM bookings WHERE coach_id = ? AND status = 'confirmed' ORDER BY id").all(coach.id)) as { id: number; payment_status: string }[];
    // One paid (by the pack, above), one unpaid marked a no-show, the rest unpaid.
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(lessons.find((l) => l.payment_status !== "paid")!.id);
    const [ana] = await coachPayouts(venueId, todayISO(), addDays(todayISO(), 30));
    expect(ana).toMatchObject({ coach: "Ana Lim", noShows: 1, noShowFees: 80 });
    expect(ana.paidFees).toBe(80);
    expect(ana.lessons).toBe(lessons.length - 1);
    expect(ana.unpaidFees).toBe((lessons.length - 2) * 80);
    const csv = await coachPayoutsCsv(venueId, todayISO(), addDays(todayISO(), 30));
    expect(csv.split("\n")[0]).toContain(`"Coach","Date","Time","Booking","Student","Court","Coach fee","Paid","Status"`);
    expect(csv).toContain("No-show");
  });

  it("lists paid lessons cancelled late, at the coach's fee times the share the venue kept", async () => {
    const one = (await getDb()
      .prepare("SELECT id FROM bookings WHERE coach_id = ? AND status = 'confirmed' AND no_show = 0 AND payment_status <> 'paid' ORDER BY id LIMIT 1")
      .get(coach.id)) as { id: number };
    await getDb()
      .prepare("UPDATE bookings SET status = 'cancelled', late_cancelled = 1, late_kept_percent = 50, payment_status = 'paid' WHERE id = ?")
      .run(one.id);
    const [ana] = await coachPayouts(venueId, todayISO(), addDays(todayISO(), 30));
    expect(ana).toMatchObject({ lateCancels: 1, lateCancelFees: 40, noShows: 1, paidFees: 80 });
  });
});
