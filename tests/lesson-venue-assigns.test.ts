import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { addTimeOff, saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { coachChoice } from "../src/lib/lesson-coaches";
import { checkIntegrity } from "../src/lib/integrity";
import { createCourt, createVenue, getBookingById, issuePass } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import * as coachesRoute from "../src/app/api/admin/coaches/route";
import * as slotsRoute from "../src/app/api/coaching/slots/route";

/**
 * Who chooses the coach of a new lesson (owner's decision of 27 October 2026;
 * lib/lesson-coaches.ts; docs/features/programmes.md#who-chooses-the-coach):
 * the customer, as before and by default, or the venue — the customer books a
 * lesson for a sport and a time and a free coach of the sport is put on it,
 * the fewest lessons that day first, then the lowest id, each tried under the
 * coach's lock; two at once get different coaches, or one is refused; a
 * lesson pack still needs its own coach.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const H = (h: number) => h * 60;
let n = 0;
let venueId: number;
let other: number;
let ana: Coach;
let ben: Coach;
let cara: Coach;
let managerCookie: string;
let managerId: number;
const ip = () => `198.19.${++n % 250}.${n % 200}`;

const post = (body: Record<string, unknown>, cookie?: string) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ name: `Learner ${++n}`, phone: `01588${String(n).padStart(5, "0")}`, ...body }),
    })
  );
const lessonAt = (date: string, hour: number, extra: Record<string, unknown> = {}, cookie?: string) =>
  post({ venueId, sport: "tennis", date, start: H(hour), end: H(hour + 1), assignCoach: true, ...extra }, cookie);
const coachOf = async (res: Response) => {
  const body = await res.json();
  if (res.status !== 201) throw new Error(JSON.stringify(body));
  return { id: body.booking.coachId as number, name: body.lessonCoach?.name as string, fee: body.booking.coachFee as number, booking: body.booking as { id: number; totalPrice: number } };
};
const setChoice = (choice: string, venue = venueId) =>
  coachesRoute.POST(
    new NextRequest("http://localhost/api/admin/coaches", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: managerCookie },
      body: JSON.stringify({ venueId: venue, action: "choice", choice }),
    })
  );

beforeAll(async () => {
  const make = async (name: string, phone: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "1 Jalan Pilih", phone });
    if (!v.ok) throw new Error("venue");
    for (const c of ["Court 1", "Court 2", "Court 3", "Court 4"]) expect((await createCourt({ venueId: v.venue.id, name: c, sport: "tennis", offPeakRate: 20, peakRate: 20 })).ok).toBe(true);
    return v.venue.id;
  };
  venueId = await make("Assign Club", "0322226666");
  other = await make("Choose Club", "0322226667");
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: H(8), until: H(20) }));
  const save = async (venue: number, name: string, rate: number) => {
    const s = await saveCoach(venue, { name, sports: ["tennis"], rate, hours });
    if (!s.ok) throw new Error(s.error);
    return s.coach;
  };
  ana = await save(venueId, "Ana Lim", 80);
  ben = await save(venueId, "Ben Tan", 100);
  cara = await save(venueId, "Cara Ong", 60);
  await save(other, "Olu Other", 70);
  const a = await createAdmin({ name: "Mo Manager", email: "mo@assign.test", password: "a long enough password", venueId, role: "manager" });
  if (!a.ok) throw new Error(a.error);
  managerId = a.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}`;
});

describe("the venue's setting", () => {
  it("is the customer's choice unless the venue says otherwise; set by a manager", async () => {
    expect(await coachChoice(venueId)).toBe("customer");
    // Customers choosing: a lesson without a coach named is refused, a named coach booked as before.
    expect(await (await lessonAt(day(3), 9)).json()).toMatchObject({ code: "LESSON_CHOOSE_COACH" });
    expect((await post({ venueId, sport: "tennis", date: day(3), start: H(9), end: H(10), coachId: ana.id })).status).toBe(201);
    expect((await setChoice("sometimes")).status).toBe(400);
    const set = await setChoice("venue");
    expect(set.status).toBe(200);
    expect(await coachChoice(venueId)).toBe("venue");
    expect(await coachChoice(other)).toBe("customer");
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE venue_id = ? AND action = 'settings.changed' ORDER BY id DESC LIMIT 1").get(venueId)) as { detail: string };
    expect(log.detail).toContain("the venue");
  });

  it("where the venue assigns, a customer cannot book a coach by name; the counter still can", async () => {
    expect(await (await post({ venueId, sport: "tennis", date: day(4), start: H(9), end: H(10), coachId: ben.id })).json()).toMatchObject({ code: "LESSON_VENUE_ASSIGNS" });
    const staff = await post({ venueId, sport: "tennis", date: day(4), start: H(9), end: H(10), coachId: ben.id }, managerCookie);
    expect(staff.status).toBe(201);
  });
});

describe("a lesson the venue assigns", () => {
  it("goes to a free coach of the sport: the fewest lessons that day, then the lowest id; the coach and fee on the confirmation", async () => {
    const date = day(5);
    const first = await coachOf(await lessonAt(date, 9));
    expect(first).toMatchObject({ id: ana.id, name: "Ana Lim", fee: 80 });
    expect(first.booking.totalPrice).toBe(100);
    // Ana has one that day now: Ben, then Cara, then Ana again.
    expect((await coachOf(await lessonAt(date, 11))).id).toBe(ben.id);
    expect((await coachOf(await lessonAt(date, 12))).id).toBe(cara.id);
    expect((await coachOf(await lessonAt(date, 13))).id).toBe(ana.id);
    // Ana is teaching at 9: another lesson then goes to whoever is free.
    expect((await coachOf(await lessonAt(date, 9))).id).toBe(ben.id);
    expect((await coachOf(await lessonAt(date, 9))).id).toBe(cara.id);
    // Nobody left at 9 (a court free, but all three coaches teaching): refused, and no booking left behind.
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n;
    expect(await (await lessonAt(date, 9)).json()).toMatchObject({ code: "LESSON_NO_COACH" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n).toBe(before);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("is refused when no coach takes lessons then, or every coach is away", async () => {
    expect(await (await lessonAt(day(6), 21)).json()).toMatchObject({ code: "LESSON_NO_COACH" });
    const off = day(7);
    for (const c of [ana, ben, cara]) expect((await addTimeOff(c.id, { from: off, until: off, reason: "Camp" })).ok).toBe(true);
    expect(await (await lessonAt(off, 10)).json()).toMatchObject({ code: "LESSON_NO_COACH" });
  });

  it("shows where a lesson can start with whichever coach is free, and their fees", async () => {
    const date = day(8);
    // Ana and Ben busy at 10; Cara free.
    await coachOf(await lessonAt(date, 10));
    await coachOf(await lessonAt(date, 10));
    const res = await slotsRoute.GET(new NextRequest(`http://localhost/api/coaching/slots?venueId=${venueId}&sport=tennis&date=${date}`, { headers: { "x-forwarded-for": ip() } }));
    const body = (await res.json()) as { starts: { minute: number }[]; rates: { min: number; max: number } };
    expect(body.rates).toEqual({ min: 60, max: 100 });
    expect(body.starts.map((s) => s.minute)).toContain(H(10));
    expect(body.starts.map((s) => s.minute)).not.toContain(H(20));
    // A venue whose customers choose has no such list.
    expect((await slotsRoute.GET(new NextRequest(`http://localhost/api/coaching/slots?venueId=${other}&sport=tennis&date=${date}`))).status).toBe(404);
  });

  it("two lessons at once for the same hour get different coaches; with one coach free, one is refused", async () => {
    for (const k of [9, 10, 11]) {
      const date = day(k);
      const [a, b] = await Promise.all([lessonAt(date, 15), lessonAt(date, 15)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const ids = [(await a.json()).booking.coachId, (await b.json()).booking.coachId];
      expect(new Set(ids).size).toBe(2);
    }
    // Only Cara free at 16: two at once, one gets her, the other is refused and leaves nothing behind.
    const date = day(12);
    await coachOf(await lessonAt(date, 16));
    await coachOf(await lessonAt(date, 16));
    const [a, b] = await Promise.all([lessonAt(date, 16), lessonAt(date, 16)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).not.toBe(201);
    const loser = a.status === 201 ? b : a;
    expect(await loser.json()).toMatchObject({ code: "LESSON_NO_COACH" });
    const held = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE date = ? AND start_min = ? AND status = 'confirmed' AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
      .get(date, H(16), venueId)) as { n: number };
    expect(held.n).toBe(3);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("paid with a lesson pack, it goes to the pack's coach, or is refused when they are not free", async () => {
    const phone = `01599${String(++n).padStart(5, "0")}`;
    const made = await registerUser({ name: "Pack Owner", email: `pack${n}@assign.test`, phone, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
    const cookie = `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}`;
    const pack = await issuePass({ venueId, name: "Five with Ben", entries: 5, entryMinutes: 60, price: 450, holderName: "Pack Owner", holderPhone: phone, userId: made.user.id, expiresOn: day(60), adminId: managerId, coachId: ben.id });
    if (!pack.ok) throw new Error(pack.error);
    const date = day(13);
    const got = await coachOf(await lessonAt(date, 9, { name: "Pack Owner", phone, payWithPass: pack.pass.code }, cookie));
    expect(got.id).toBe(ben.id);
    expect((await getBookingById(got.booking.id))!.paymentStatus).toBe("paid");
    // Ben is now teaching at 9: with his pack, the lesson is not given to anybody else.
    expect(await (await lessonAt(date, 9, { name: "Pack Owner", phone, payWithPass: pack.pass.code }, cookie)).json()).toMatchObject({ code: "LESSON_NO_COACH" });
  });
});
