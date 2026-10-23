import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { coachById, lessonSlots, listCoaches, retireCoach, saveCoach, type Coach } from "../src/lib/coaching";
import { bookingSale } from "../src/lib/documents";
import { getDb } from "../src/lib/db";
import { adminCancelBooking, createCourt, createPromoCode, createVenue, findBooking, rescheduleBooking, venueHours } from "../src/lib/store";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { GET as slotsRoute } from "../src/app/api/coaching/slots/route";

/**
 * One-to-one lessons: a court booking with a coach on it, their fee on top,
 * and a coach in one place at a time.
 */

let venueId: number;
let coach: Coach;
const date = addDays(todayISO(), 3);
let n = 0;

const post = (body: Record<string, unknown>) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}` },
      body: JSON.stringify({ venueId, sport: "tennis", date, name: "Pupil", phone: `01277700${String(n).padStart(2, "0")}`, ...body }),
    })
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Coach Club", area: "Bangsar", address: "1 Jalan Jurulatih", phone: "0322223333" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  for (const name of ["Court 1", "Court 2"]) {
    const c = await createCourt({ venueId, name, sport: "tennis", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
  }
  await createCourt({ venueId, name: "Pool", sport: "badminton", offPeakRate: 10, peakRate: 10 });
});

describe("a venue's coaches", () => {
  it("are checked as they are added", async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8, until: 20 }));
    expect(await saveCoach(venueId, { name: "", sports: ["tennis"], rate: 80, hours })).toMatchObject({ ok: false });
    expect(await saveCoach(venueId, { name: "Ana", sports: [], rate: 80, hours })).toMatchObject({ ok: false });
    expect(await saveCoach(venueId, { name: "Ana", sports: ["tennis"], rate: 80, hours: [{ weekday: 1, from: 18, until: 9 }] })).toMatchObject({ ok: false });
    const saved = await saveCoach(venueId, { name: "Ana Lim", bio: "Former state player.", sports: ["tennis"], rate: 80, hours });
    if (!saved.ok) throw new Error(saved.error);
    coach = saved.coach;
    expect(coach).toMatchObject({ name: "Ana Lim", sports: ["tennis"], rate: 80, active: true });
    expect(coach.hours).toHaveLength(7);
    expect(await listCoaches(venueId, { activeOnly: true })).toHaveLength(1);
  });
});

describe("booking a lesson", () => {
  it("books a court with the coach on it, their fee on top", async () => {
    const res = await post({ hours: [10], coachId: coach.id });
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    expect(booking).toMatchObject({ totalPrice: 100, coachId: coach.id, coachFee: 80 });
    const sale = (await bookingSale(booking.id))!;
    expect(sale.lines.map((l) => [l.description.split(",")[0], l.amount])).toEqual([
      ["Court 1 (Tennis)", 20],
      ["Coaching with Ana Lim", 80],
    ]);
  });

  it("will not put the coach in two places at once, and lets the second court go", async () => {
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n;
    const res = await post({ hours: [10], coachId: coach.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "COACH_TAKEN", vars: { name: "Ana Lim" } });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n).toBe(before);
  });

  it("is refused outside the coach's hours, in a sport they do not coach, or weekly", async () => {
    expect(await (await post({ hours: [21], coachId: coach.id })).json()).toMatchObject({ code: "COACH_NOT_WORKING" });
    expect(await (await post({ sport: "badminton", hours: [11], coachId: coach.id })).json()).toMatchObject({ code: "COACH_NOT_FOUND" });
    // Weekly: a guest is refused that for want of an account before the coach is asked; either way, no.
    const weekly = await (await post({ hours: [11], coachId: coach.id, weeks: 2 })).json();
    expect(["COACH_ONE_WEEK", "SERIES_NEEDS_ACCOUNT"]).toContain(weekly.code);
  });

  it("offers only the times the coach is free and a court is", async () => {
    const venue = await venueHours(venueId);
    const free = await lessonSlots(coach, date, () => true, venue, 1);
    expect(free).not.toContain(10);
    expect(free).toContain(11);
    expect(free).not.toContain(20);
    const res = await slotsRoute(new NextRequest(`http://localhost/api/coaching/slots?coachId=${coach.id}&date=${date}`));
    expect((await res.json()).slots).toEqual(free);
  });

  it("frees the coach when the lesson is cancelled", async () => {
    const res = await post({ hours: [12], coachId: coach.id });
    const { booking } = await res.json();
    await adminCancelBooking(booking.code);
    expect((await post({ hours: [12], coachId: coach.id })).status).toBe(201);
  });

  it("is not moved by the customer: the coach's time is the venue's to change", async () => {
    const { booking } = await (await post({ hours: [14], coachId: coach.id })).json();
    const moved = await rescheduleBooking(booking.code, { date, startHour: 15 }, "customer");
    expect(moved).toMatchObject({ ok: false, code: "RESCHEDULE_COACH" });
  });

  it("takes a promo code off the court, not the coach's fee", async () => {
    await ensureBootstrapAdmin();
    const adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
    const promo = await createPromoCode({
      venueId, code: "HALF", description: "Half off", kind: "percent", value: 50,
      validFrom: todayISO(), validTo: addDays(todayISO(), 30), adminId,
    });
    if (!promo.ok) throw new Error(promo.error);
    const res = await post({ hours: [16], coachId: coach.id, promoCode: "HALF" });
    const { booking, discount } = await res.json();
    expect(discount).toBe(10);
    expect(booking.totalPrice).toBe(90);
    const found = (await findBooking(booking.code, booking.phone))!;
    expect(found.totalPrice).toBe(90);
  });

  it("stops when the coach is retired", async () => {
    expect(await retireCoach(coach.id, venueId)).toBe(true);
    expect((await coachById(coach.id))!.active).toBe(false);
    expect(await (await post({ hours: [17], coachId: coach.id })).json()).toMatchObject({ code: "COACH_NOT_FOUND" });
  });
});
