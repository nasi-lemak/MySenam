import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { GET as choicesRoute, POST as moveRoute } from "../src/app/api/admin/bookings/move-series/route";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { attachCoach, coachById, saveCoach } from "../src/lib/coaching";
import { notifyCoaches, setCoachEmail } from "../src/lib/coach-schedule";
import { getDb } from "../src/lib/db";
import { moveSeries, previewSeriesMove, weekDate, type SeriesMoveWeek } from "../src/lib/series-moves";
import { closeVenueDay, createBooking, createBookingSeries, createCourt, createVenue, listBookingsForDate, setPaymentStatus } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * Staff move the weeks of a weekly series still to be played in one step:
 * previewed week by week, each week by the single staff move (what is free,
 * the court's rules, the price as the single move sets it), the weeks that
 * can move moved and the others named with why, the customer told once, the
 * coach of a lesson series told once, and each week and the series logged.
 */

let venueId: number;
let court1: number;
let court2: number;
let managerCookie: string;
let deskCookie: string;
let manager: { id: number; name: string; role: string };
let n = 0;
const phone = () => `0188800${String(++n).padStart(3, "0")}`;

/** The first `weekday` at least `days` ahead. */
function ahead(weekday: number, days: number): string {
  let d = addDays(todayISO(), days);
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return d;
}

const post = (body: object, cookie = deskCookie) =>
  moveRoute(new NextRequest("http://localhost/api/admin/bookings/move-series", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

async function series(courtId: number, first: string, weeks: number, opts: { email?: string } = {}) {
  const made = await createBookingSeries({ courtId, date: first, hours: [10], weeks, name: "Siti Series", phone: phone(), ...(opts.email ? { email: opts.email } : {}), by: "staff" });
  if (!made.ok || !made.seriesCode) throw new Error(made.ok ? "no series" : made.error);
  return { ...made, seriesCode: made.seriesCode };
}

const row = async (id: number) =>
  (await getDb().prepare("SELECT date, start_min, court_id, total_price::float AS total_price, status FROM bookings WHERE id = ?").get(id)) as {
    date: string;
    start_min: number;
    court_id: number;
    total_price: number;
    status: string;
  };

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Move Hall", area: "Ipoh", address: "x", phone: "0355550201", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id = ?").run(venueId);
  const a = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30, capacity: 1 });
  const b = await createCourt({ venueId, name: "Court 2", sport: "badminton", offPeakRate: 20, peakRate: 30, capacity: 1 });
  if (!a.ok || !b.ok) throw new Error("court");
  court1 = a.court.id;
  court2 = b.court.id;
  const m = await createAdmin({ name: "Mira Manager", email: "mira@move.my", password: "manager-pass-1", venueId });
  const d = await createAdmin({ name: "Dewi Desk", email: "dewi@move.my", password: "desk-password-1", venueId, role: "desk" });
  if (!m.ok || !d.ok) throw new Error("staff");
  manager = { id: m.admin.id, name: m.admin.name, role: "manager" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
});

describe("the new date of each week", () => {
  it("is the weekday asked for in the week's own Monday-to-Sunday week", () => {
    // 2026-11-03 is a Tuesday.
    expect(weekDate("2026-11-03", 4)).toBe("2026-11-05");
    expect(weekDate("2026-11-03", 1)).toBe("2026-11-02");
    expect(weekDate("2026-11-03", 0)).toBe("2026-11-08");
    expect(weekDate("2026-11-03", undefined)).toBe("2026-11-03");
  });
});

describe("moving a weekly series in one step", () => {
  it("previews each week as the single move would, moves the weeks that can, and leaves the others with why", async () => {
    const tuesday = ahead(2, 8);
    const made = await series(court1, tuesday, 4, { email: "siti@example.com" });
    const [w1, w2, w3, w4] = made.bookings;
    // The first week paid at the counter: it keeps what was paid.
    expect((await setPaymentStatus(w1.code, true, "cash")).ok).toBe(true);
    // Week 3's Thursday evening is taken on court 1; week 4's Thursday the venue is closed.
    const taken = await createBooking({ courtId: court1, date: addDays(w3.date, 2), hours: [18], name: "Somebody Else", phone: phone() });
    if (!taken.ok) throw new Error(taken.error);
    expect((await closeVenueDay(venueId, addDays(w4.date, 2), "Event")).ok).toBe(true);

    // What staff choose from: the series as it is and its venue's courts.
    const choices = await choicesRoute(new NextRequest(`http://localhost/api/admin/bookings/move-series?seriesCode=${made.seriesCode}`, { headers: { cookie: deskCookie } }));
    expect(await choices.json()).toMatchObject({ weekday: 2, start: 600, courtId: court1, weeks: 4, courts: [{ id: court1 }, { id: court2 }] });

    const to = { seriesCode: made.seriesCode, weekday: 4, start: 18 * 60, courtId: court1 };
    const seen = await post({ ...to, preview: true });
    expect(seen.status).toBe(200);
    const weeks = ((await seen.json()) as { weeks: SeriesMoveWeek[] }).weeks;
    expect(weeks.map((w) => [w.code, w.movable])).toEqual([
      [w1.code, true],
      [w2.code, true],
      [w3.code, false],
      [w4.code, false],
    ]);
    // Paid: the price stays, the difference said and not charged. Unpaid: priced at the new (peak) time.
    expect(weeks[0]).toMatchObject({ priceChange: 0, unchargedDifference: 10, to: { date: addDays(w1.date, 2), startMin: 1080, courtId: court1 } });
    expect(weeks[1]).toMatchObject({ priceChange: 10 });
    expect(weeks[2].refusal?.code).toBe("RESCHEDULE_TAKEN");
    expect(weeks[3].refusal?.code).toBe("VENUE_CLOSED");
    // Nothing changed by looking.
    expect(await row(w1.id)).toMatchObject({ date: w1.date, start_min: 600 });

    const done = await post({ ...to, codes: [w1.code, w2.code] });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { moved: { code: string }[]; left: unknown[] };
    expect(body.moved.map((m) => m.code)).toEqual([w1.code, w2.code]);
    expect(body.left).toEqual([]);
    expect(await row(w1.id)).toMatchObject({ date: addDays(w1.date, 2), start_min: 1080, court_id: court1, total_price: 20 });
    expect(await row(w2.id)).toMatchObject({ date: addDays(w2.date, 2), start_min: 1080, total_price: 30 });
    expect(await row(w3.id)).toMatchObject({ date: w3.date, start_min: 600 });
    expect(await row(w4.id)).toMatchObject({ date: w4.date, start_min: 600 });

    // The customer is told once, for the weeks moved, not once a week.
    const told = (await getDb()
      .prepare("SELECT dedupe_key, subject FROM messages WHERE recipient = 'siti@example.com' AND kind = 'booking_rescheduled'")
      .all()) as { dedupe_key: string; subject: string }[];
    expect(told).toHaveLength(1);
    expect(told[0].dedupe_key).toMatch(/^rescheduled-series:/);
    expect(told[0].subject).toContain(made.seriesCode.toUpperCase());
    // Each week and the series in the activity log.
    const logged = (await getDb().prepare("SELECT action, booking_code FROM staff_actions WHERE venue_id = ? AND action IN ('booking.rescheduled', 'booking.series_moved') ORDER BY id").all(venueId)) as {
      action: string;
      booking_code: string;
    }[];
    expect(logged).toEqual([
      { action: "booking.rescheduled", booking_code: w1.code },
      { action: "booking.rescheduled", booking_code: w2.code },
      { action: "booking.series_moved", booking_code: made.seriesCode.toUpperCase() },
    ]);
  });

  it("leaves a week taken since the preview where it is, and moves the rest", async () => {
    const tuesday = ahead(2, 22);
    const made = await series(court2, tuesday, 2);
    const [w1, w2] = made.bookings;
    const to = { weekday: 3, start: 9 * 60, courtId: court2 };
    const seen = await previewSeriesMove(made.seriesCode, to);
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.weeks.every((w) => w.movable)).toBe(true);
    // Somebody books week 2's new time in the meantime.
    const taken = await createBooking({ courtId: court2, date: addDays(w2.date, 1), hours: [9], name: "Quick Booker", phone: phone() });
    if (!taken.ok) throw new Error(taken.error);
    const done = await moveSeries(manager, made.seriesCode, to, { codes: [w1.code, w2.code] });
    if (!done.ok) throw new Error(done.error);
    expect(done.moved.map((m) => m.booking.code)).toEqual([w1.code]);
    expect(done.left).toEqual([expect.objectContaining({ code: w2.code, errorCode: "RESCHEDULE_TAKEN" })]);
    expect(await row(w2.id)).toMatchObject({ date: w2.date, start_min: 600 });
    // Week 2's own time and the new one of week 1 are each held once: no double booking.
    expect((await createBooking({ courtId: court2, date: addDays(w1.date, 1), hours: [9], name: "Late", phone: phone() })).ok).toBe(false);
  });

  it("refuses a desk going past the court's rules, a week not of the series, and a series not found", async () => {
    const made = await series(court1, ahead(5, 30), 2);
    expect((await post({ seriesCode: made.seriesCode, start: 600, weekday: 6, override: true })).status).toBe(403);
    expect((await post({ seriesCode: made.seriesCode, start: 600, weekday: 6, codes: ["NOPE"] })).status).toBe(409);
    expect((await post({ seriesCode: "SR-NOTHER", start: 600 }, managerCookie)).status).toBe(404);
    expect((await post({ seriesCode: made.seriesCode, start: "25:99" })).status).toBe(400);
    expect((await post({ seriesCode: made.seriesCode, start: 600, weekday: 9 })).status).toBe(400);
  });
});

describe("a lesson series moved", () => {
  it("tells its coach once, not once a week", async () => {
    const coach = await saveCoach(venueId, { name: "Coach Kamal", sports: ["badminton"], rate: 40, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 7 * 60, until: 23 * 60 })) });
    if (!coach.ok) throw new Error(coach.error);
    expect((await setCoachEmail(coach.coach.id, venueId, "kamal@coach.my")).ok).toBe(true);
    const made = await series(court1, ahead(1, 40), 3);
    for (const b of made.bookings) expect(await attachCoach(b.id, (await coachById(coach.coach.id))!)).toMatchObject({ ok: true });
    await notifyCoaches(new Date(Date.now() + 1000));
    const mail = async () =>
      (await getDb().prepare("SELECT subject FROM messages WHERE recipient = 'kamal@coach.my' AND kind = 'coach_lesson' ORDER BY id").all()) as { subject: string }[];
    const before = (await mail()).length;
    expect(before).toBeGreaterThan(0);
    const done = await post({ seriesCode: made.seriesCode, weekday: 1, start: 14 * 60 });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { moved: unknown[] }).moved).toHaveLength(3);
    const after = await mail();
    expect(after.length - before).toBe(1);
    expect(after.at(-1)!.subject).toBe("Moved: 3 weekly lessons with Siti Series");
  });
});

describe("the day list", () => {
  it("is in time order, then by court", async () => {
    const date = ahead(3, 45);
    const late = await createBooking({ courtId: court1, date, hours: [20], name: "Late One", phone: phone() });
    const early = await createBooking({ courtId: court2, date, hours: [16], name: "Early One", phone: phone() });
    const same = await createBooking({ courtId: court1, date, hours: [16], name: "Same Time", phone: phone() });
    if (!late.ok || !early.ok || !same.ok) throw new Error("booking");
    const codes = (await listBookingsForDate(date, venueId)).map((b) => b.code);
    expect(codes).toEqual([same.booking.code, early.booking.code, late.booking.code]);
  });
});
