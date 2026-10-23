import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { claimsOf } from "./helpers/bookings";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { notifyRescheduled } from "../src/lib/notify";
import {
  createBooking,
  createClassSessions,
  createCourt,
  listVenues,
  rescheduleBooking,
  rescheduleOptions,
  setPaymentStatus,
} from "../src/lib/store";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { updatePolicy } from "../src/lib/booking-policy";
import { POST as customerPost, GET as customerGet } from "../src/app/api/bookings/reschedule/route";
import { POST as staffPost } from "../src/app/api/admin/bookings/reschedule/route";

/**
 * Changing a booking's day or time, keeping its code and payment: the step
 * that otherwise means cancel, refund and book again.
 */

await ensureBootstrapAdmin();
const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;

/**
 * The nth weekday after today, so 10am is off-peak and 7pm peak. Counting
 * weekdays rather than days gives each n its own date whatever day the
 * tests run on, so tests using different n never share a court's hours.
 */
function weekday(n: number): string {
  let d = todayISO();
  for (let found = 0; found < n; ) {
    d = addDays(d, 1);
    if (!isPeakMinute(d, 10 * 60)) found++;
  }
  return d;
}

let n = 0;
const phone = () => `01299${String(++n).padStart(5, "0")}`;

async function badminton() {
  return (await listVenues())[0].courts.filter((c) => c.sport === "badminton");
}
async function book(courtId: number, hours: number[], date: string, who = phone(), email?: string) {
  const r = await createBooking({ courtId, date, hours, name: "Aisyah Rahman", phone: who, email });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}
const slotsOf = claimsOf;

describe("changing a booking's time", () => {
  it("keeps the code, moves its places, and frees the old time", async () => {
    const date = weekday(3);
    const later = addDays(date, 1) > addDays(todayISO(), 13) ? date : weekday(4);
    const [c1] = await badminton();
    const b = await book(c1.id, [10, 11], date);

    const done = await rescheduleBooking(b.code, { date: later, startHour: 14 }, "customer");
    expect(done).toMatchObject({ ok: true, priceChange: 0 });
    if (!done.ok) return;
    expect(done.booking).toMatchObject({ code: b.code, date: later, startHour: 14, endHour: 16, courtId: c1.id, totalPrice: b.totalPrice });
    expect(done.from).toMatchObject({ date, startHour: 10 });
    // Held as one claim, to the minute.
    expect(await slotsOf(b.id)).toEqual([{ court_id: c1.id, date: later, start: 14 * 60, end: 16 * 60 }]);
    // The old time is somebody else's to book now.
    await book(c1.id, [10, 11], date);
  });

  it("can overlap the time it already has", async () => {
    const date = weekday(5);
    const [c1] = await badminton();
    const b = await book(c1.id, [10, 11], date);
    const options = await rescheduleOptions(b.code, date);
    expect(options.find((o) => o.startHour === 11 && o.courtId === c1.id)).toBeTruthy();
    expect(options.some((o) => o.startHour === 10)).toBe(false);
    expect(await rescheduleBooking(b.code, { date, startHour: 11 }, "customer")).toMatchObject({ ok: true });
    expect((await slotsOf(b.id)).map((s) => [s.start, s.end])).toEqual([[11 * 60, 13 * 60]]);
  });

  it("goes to another court of the sport when its own is taken, and refuses when none is free", async () => {
    const date = weekday(6);
    const courts = await badminton();
    const b = await book(courts[0].id, [8], date);
    await book(courts[0].id, [20], date);
    const moved = await rescheduleBooking(b.code, { date, startHour: 20 }, "customer");
    expect(moved).toMatchObject({ ok: true });
    if (moved.ok) expect(moved.booking.courtId).not.toBe(courts[0].id);

    for (const c of courts) await book(c.id, [21], date).catch(() => undefined);
    expect(await rescheduleBooking(b.code, { date, startHour: 21 }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_TAKEN" });
    expect((await rescheduleOptions(b.code, date)).some((o) => o.startHour === 21)).toBe(false);
  });

  it("reprices an unpaid booking at the new time's rate", async () => {
    const date = weekday(3);
    const [, c2] = await badminton();
    const b = await book(c2.id, [11], date);
    const done = await rescheduleBooking(b.code, { date, startHour: 19 }, "customer");
    expect(done).toMatchObject({ ok: true, priceChange: c2.peakRate - c2.offPeakRate });
    if (done.ok) expect(done.booking.totalPrice).toBe(c2.peakRate);
    const back = await rescheduleBooking(b.code, { date, startHour: 12 }, "customer");
    expect(back).toMatchObject({ ok: true, priceChange: c2.offPeakRate - c2.peakRate });
    if (back.ok) expect(back.booking.totalPrice).toBe(c2.offPeakRate);
  });

  it("keeps a paid booking's price: a customer cannot move it somewhere dearer, staff can", async () => {
    const date = weekday(4);
    const [, , c3] = await badminton();
    const b = await book(c3.id, [11], date);
    await setPaymentStatus(b.code, true);
    expect(await rescheduleBooking(b.code, { date, startHour: 19, courtId: c3.id }, "customer")).toMatchObject({
      ok: false,
      code: "RESCHEDULE_DEARER",
    });
    const options = await rescheduleOptions(b.code, date);
    expect(options.find((o) => o.startHour === 19)?.difference).toBe(c3.peakRate - c3.offPeakRate);

    const staff = await rescheduleBooking(b.code, { date, startHour: 19, courtId: c3.id }, "staff");
    expect(staff).toMatchObject({ ok: true, priceChange: 0, unchargedDifference: c3.peakRate - c3.offPeakRate });
    if (staff.ok) expect(staff.booking).toMatchObject({ totalPrice: c3.offPeakRate, paymentStatus: "paid" });
  });

  it("holds customers to the cancellation cutoff, not staff", async () => {
    const date = addDays(todayISO(), 1);
    const [c1] = await badminton();
    const venueId = c1.venueId;
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 72 WHERE id = ?").run(venueId);
    try {
      const b = await book(c1.id, [20], date);
      expect(await rescheduleBooking(b.code, { date, startHour: 21 }, "customer")).toMatchObject({
        ok: false,
        code: "RESCHEDULE_CUTOFF",
        vars: { n: 72 },
      });
      expect(await rescheduleBooking(b.code, { date, startHour: 21 }, "staff")).toMatchObject({ ok: true });
    } finally {
      await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 2 WHERE id = ?").run(venueId);
    }
  });

  it("refuses the same time, a time out of the window or hours, a checked-in booking and a class place", async () => {
    const date = weekday(5);
    const [, c2] = await badminton();
    const b = await book(c2.id, [13], date);
    expect(await rescheduleBooking(b.code, { date, startHour: 13 }, "customer")).toMatchObject({ code: "RESCHEDULE_SAME" });
    expect(await rescheduleBooking(b.code, { date: addDays(todayISO(), 40), startHour: 13 }, "customer")).toMatchObject({
      code: "DATE_OUT_OF_WINDOW",
    });
    expect(await rescheduleBooking(b.code, { date, startHour: 3 }, "customer")).toMatchObject({ code: "HOURS_OUTSIDE_OPENING" });
    expect(await rescheduleBooking("MS-NOPE00", { date, startHour: 14 }, "customer")).toMatchObject({ code: "BOOKING_NOT_FOUND" });

    await getDb().prepare("INSERT INTO check_ins (booking_id, checked_in_at) VALUES (?, datetime('now'))").run(b.id);
    expect(await rescheduleBooking(b.code, { date, startHour: 14 }, "staff")).toMatchObject({ code: "RESCHEDULE_CHECKED_IN" });

    const made = await createClassSessions({
      courtId: c2.id,
      name: "Clinic",
      instructor: "Coach Lee",
      date: addDays(date, 1),
      startHour: 9,
      endHour: 10,
      capacity: 1,
      price: 20,
    });
    if (!made.ok) throw new Error(made.error);
    await getDb()
      .prepare(
        "INSERT INTO bookings (code, court_id, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, class_id) VALUES ('MS-CLS001', ?, ?, 540, 600, now(), now() + interval '1 hour', 'X', '0123', 20, ?)"
      )
      .run(c2.id, addDays(date, 1), made.classes[0].id);
    expect(await rescheduleBooking("MS-CLS001", { date, startHour: 15 }, "staff")).toMatchObject({ code: "RESCHEDULE_CLASS" });
  });
});

describe("telling the customer", () => {
  it("emails a customer who changed it themselves, and asks one the venue changed it for to acknowledge", async () => {
    const date = weekday(7);
    const [c1] = await badminton();
    const b = await book(c1.id, [10], date, phone(), "aisyah@example.com");
    const mine = await rescheduleBooking(b.code, { date, startHour: 11 }, "customer");
    if (!mine.ok) throw new Error(mine.error);
    await notifyRescheduled(mine.booking, "customer", 0);
    const emails = (await getDb()
      .prepare("SELECT channel, kind, body FROM messages WHERE booking_id = ? AND kind = 'booking_rescheduled'")
      .all(b.id)) as { channel: string; kind: string; body: string }[];
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ channel: "email" });
    expect(emails[0].body).toContain("as you asked");

    const theirs = await rescheduleBooking(b.code, { date, startHour: 12 }, "staff");
    if (!theirs.ok) throw new Error(theirs.error);
    const notice = await notifyRescheduled(theirs.booking, "staff", 0);
    expect(notice).not.toBeNull();
    const latest = (await getDb()
      .prepare("SELECT body FROM messages WHERE booking_id = ? AND kind = 'booking_rescheduled' ORDER BY id DESC LIMIT 1")
      .get(b.id)) as { body: string };
    expect(latest.body).toContain("has changed the time");
    expect(latest.body).toContain("/ack/");
  });
});

describe("the endpoints", () => {
  it("need the booking's phone number from a customer, and a session from staff", async () => {
    const date = weekday(8);
    const [c1] = await badminton();
    const who = phone();
    const b = await book(c1.id, [10], date, who);
    const post = (body: unknown) =>
      customerPost(new NextRequest("http://localhost/api/bookings/reschedule", { method: "POST", body: JSON.stringify(body) }));

    expect((await post({ code: b.code, phone: "0000000000", date, startHour: 12 })).status).toBe(404);
    expect((await post({ code: b.code })).status).toBe(400);
    const ok = await post({ code: b.code, phone: who, date, startHour: 12 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).booking).toMatchObject({ code: b.code, startHour: 12 });

    const listed = await customerGet(
      new NextRequest(`http://localhost/api/bookings/reschedule?code=${b.code}&phone=${who}&date=${date}`)
    );
    expect((await listed.json()).options.length).toBeGreaterThan(0);

    const staff = await staffPost(
      new NextRequest("http://localhost/api/admin/bookings/reschedule", {
        method: "POST",
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ code: b.code, date, startHour: 14, courtId: c1.id }),
      })
    );
    expect(staff.status).toBe(200);
    const anonymous = await staffPost(
      new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", body: JSON.stringify({ code: b.code, date, startHour: 15 }) })
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("a manager moving a booking past the rules", () => {
  it("goes past the target court's length rule on record, never past what holds the court", async () => {
    const date = weekday(5);
    const venueId = (await listVenues())[0].id;
    const made = await createCourt({ venueId, name: "Long Court", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!made.ok) throw new Error(made.error);
    const long = made.court.id;
    // Sold 90 minutes at least.
    expect(await updatePolicy({ court: long }, { minLength: 90, lengthStep: 30 })).toMatchObject({ ok: true });
    const b = await book((await badminton())[0].id, [10], date);
    const move = (body: Record<string, unknown>) =>
      staffPost(new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ code: b.code, date, ...body }) }));
    // The customer, and staff not going past the rules, are held to them.
    expect(await rescheduleBooking(b.code, { date, start: 12 * 60, courtId: long }, "customer")).toMatchObject({ ok: false });
    expect((await move({ start: 12 * 60, courtId: long })).status).toBe(409);
    // Something already there refuses even a manager.
    await book(long, [14, 15], date);
    expect((await move({ start: 14 * 60, courtId: long, override: true })).status).toBe(409);
    // Past the length rule, on a manager's say: done, and on the record.
    expect((await move({ start: 12 * 60, courtId: long, override: true })).status).toBe(200);
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'booking.override' AND booking_code = ?").get(b.code)) as { detail: string };
    expect(log.detail).toMatch(/past/);
  });
});

describe("booking again", () => {
  it("picks the same court and hours on the next free day, the same weekday first", async () => {
    const { bookAgainLink } = await import("../src/lib/store");
    const { GET } = await import("../src/app/api/bookings/again/route");
    const date = weekday(1);
    const [c1, c2] = await badminton();
    const who = phone();
    const b = await book(c1.id, [17, 18], date, who);
    const next = addDays(date, 7);
    // Its court is taken a week on, but another is free.
    await book(c1.id, [17, 18], next);
    const url = await bookAgainLink(b.code);
    expect(url).toMatch(new RegExp(`^/venue/${c1.venueId}\\?date=${next}&sport=badminton&court=(?!${c1.id}&)\\d+&start=1020&minutes=120$`));
    void c2;

    const res = await GET(new NextRequest(`http://localhost/api/bookings/again?code=${b.code}&phone=${who}`));
    expect((await res.json()).url).toBe(url);
    expect((await GET(new NextRequest(`http://localhost/api/bookings/again?code=${b.code}&phone=0100000000`))).status).toBe(404);
    expect((await GET(new NextRequest(`http://localhost/api/bookings/again?code=${b.code}`))).status).toBe(404);
  });
});
