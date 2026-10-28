import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { changeAlerts, setBookingAlerts, setChangeAlerts } from "../src/lib/notify";
import { adminCancelBooking, createBooking, listVenues } from "../src/lib/store";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { POST as cancelOnline } from "../src/app/api/bookings/cancel/route";
import { POST as rescheduleOnline } from "../src/app/api/bookings/reschedule/route";
import { GET as alertsGet, POST as alertsPost } from "../src/app/api/admin/booking-alerts/route";

/**
 * The venue may also hear when a customer cancels or changes a booking
 * online (X1-11): at the same address and number as new-booking alerts,
 * through the outbox, off unless turned on, and only for bookings starting
 * within the window it chose (a day unless widened).
 */

let venueId: number;
let courtId: number;
let managerCookie: string;
let n = 0;

const alertsFor = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT channel, recipient, subject, body FROM messages WHERE booking_id = ? AND kind = 'venue_booking_change' ORDER BY id")
    .all(bookingId)) as { channel: string; recipient: string; subject: string; body: string }[];

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts.find((c) => c.capacity === 1)!.id;
  const manager = await createAdmin({ name: "Alia Manager", email: "alia-alerts@venue.my", password: "manager-pass-1", venueId });
  if (!manager.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  expect((await setBookingAlerts(venueId, { email: "desk@arena.my" })).ok).toBe(true);
});

/** A booking on `date` at an off-peak hour, made as the counter makes them. */
async function booked(date: string, hour = 10) {
  n++;
  let at = hour;
  while (isPeakMinute(date, at * 60)) at++;
  const made = await createBooking({ courtId, date, hours: [at], name: `Rahim ${n}`, phone: `01955500${String(n).padStart(2, "0")}` });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

const cancel = (code: string, phone: string) =>
  cancelOnline(new NextRequest("http://localhost/api/bookings/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, phone }) }));

describe("alerts for customers' online cancellations and changes", () => {
  it("are off by default, a day ahead once on, and set by the venue's managers", async () => {
    expect(await changeAlerts(venueId)).toEqual({ cancellations: false, changes: false, withinHours: 24 });
    const got = await alertsGet(new NextRequest(`http://localhost/api/admin/booking-alerts?venueId=${venueId}`, { headers: { cookie: managerCookie } }));
    expect((await got.json()).changes).toEqual({ cancellations: false, changes: false, withinHours: 24 });
    const refused = await alertsPost(
      new NextRequest("http://localhost/api/admin/booking-alerts", { method: "POST", headers: { cookie: managerCookie }, body: JSON.stringify({ venueId, email: "desk@arena.my", cancellations: true, withinHours: 5 }) })
    );
    expect(refused.status).toBe(400);
    expect(await changeAlerts(venueId)).toMatchObject({ cancellations: false });
  });

  it("say nothing while off", async () => {
    const b = await booked(addDays(todayISO(), 1));
    expect((await cancel(b.code, b.phone)).status).toBe(200);
    expect(await alertsFor(b.id)).toEqual([]);
  });

  it("tell the venue of a cancellation online within its window, and not of one further ahead", async () => {
    const saved = await alertsPost(
      new NextRequest("http://localhost/api/admin/booking-alerts", {
        method: "POST",
        headers: { cookie: managerCookie },
        body: JSON.stringify({ venueId, email: "desk@arena.my", phone: "", cancellations: true, changes: true, withinHours: 48 }),
      })
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).changes).toEqual({ cancellations: true, changes: true, withinHours: 48 });

    const soon = await booked(addDays(todayISO(), 1));
    expect((await cancel(soon.code, soon.phone)).status).toBe(200);
    const [mail] = await alertsFor(soon.id);
    expect(mail).toMatchObject({ channel: "email", recipient: "desk@arena.my" });
    expect(mail.subject).toContain("Booking cancelled:");
    expect(mail.body).toContain("A booking was cancelled online.");
    expect(mail.body).toContain(`${soon.name}, ${soon.phone}`);
    expect(mail.body).toContain(soon.code);

    const later = await booked(addDays(todayISO(), 6));
    expect((await cancel(later.code, later.phone)).status).toBe(200);
    expect(await alertsFor(later.id)).toEqual([]);
  });

  it("tell the venue of a change online, saying where it was", async () => {
    const b = await booked(addDays(todayISO(), 1), 10);
    const res = await rescheduleOnline(
      new NextRequest("http://localhost/api/bookings/reschedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: b.code, phone: b.phone, date: addDays(todayISO(), 1), start: (b.startMin + 120) }),
      })
    );
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const [mail] = await alertsFor(b.id);
    expect(mail.body).toContain("A booking was changed (it was");
  });

  it("are not sent for what staff do at the desk", async () => {
    const b = await booked(addDays(todayISO(), 1), 13);
    expect((await adminCancelBooking(b.code)).ok).toBe(true);
    expect(await alertsFor(b.id)).toEqual([]);
  });

  it("are written in the language chosen for the venue's alerts, as new-booking alerts are", async () => {
    expect((await setBookingAlerts(venueId, { email: "desk@arena.my", locale: "ms" })).ok).toBe(true);
    const b = await booked(addDays(todayISO(), 1), 15);
    expect((await cancel(b.code, b.phone)).status).toBe(200);
    const [mail] = (await getDb()
      .prepare("SELECT locale, body FROM messages WHERE booking_id = ? AND kind = 'venue_booking_change'")
      .all(b.id)) as { locale: string; body: string }[];
    expect(mail.locale).toBe("ms");
    expect(mail.body).not.toContain("A booking was cancelled online.");
    expect((await setBookingAlerts(venueId, { email: "desk@arena.my", locale: null })).ok).toBe(true);
  });

  it("can be widened to any time ahead, and turned off again", async () => {
    expect(await setChangeAlerts(venueId, { withinHours: null })).toMatchObject({ ok: true, changes: { withinHours: null } });
    const far = await booked(addDays(todayISO(), 9));
    expect((await cancel(far.code, far.phone)).status).toBe(200);
    expect(await alertsFor(far.id)).toHaveLength(1);
    expect(await setChangeAlerts(venueId, { cancellations: false })).toMatchObject({ ok: true, changes: { cancellations: false, changes: true } });
  });
});
