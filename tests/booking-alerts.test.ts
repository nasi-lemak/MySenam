import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { bookingAlerts, setBookingAlerts } from "../src/lib/notify";
import { createBooking, listVenues } from "../src/lib/store";
import { enqueue, MESSAGES_PER_RECIPIENT_PER_DAY } from "../src/lib/outbox";
import { addDays, isPeak, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/** The venue hears about bookings customers make online, where it asked to. */

let venueId: number;
let courtId: number;
let date: string;

const alertsFor = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT channel, recipient, subject, body, status FROM messages WHERE booking_id = ? AND kind = 'venue_new_booking' ORDER BY id")
    .all(bookingId)) as { channel: string; recipient: string; subject: string; body: string; status: string }[];

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts.find((c) => c.capacity === 1)!.id;
  date = addDays(todayISO(), 4);
  while (isPeak(date, 9)) date = addDays(date, 1);
});

describe("new-booking alerts", () => {
  it("are off until the venue gives an address or number, and checked when it does", async () => {
    expect(await bookingAlerts(venueId)).toEqual({ email: null, phone: null });
    expect(await setBookingAlerts(venueId, { email: "not an email" })).toMatchObject({ ok: false });
    expect(await setBookingAlerts(venueId, { phone: "123" })).toMatchObject({ ok: false });
    expect(await setBookingAlerts(venueId, { email: "desk@arena.my", phone: "012-888 9999" })).toEqual({
      ok: true,
      alerts: { email: "desk@arena.my", phone: "012-888 9999" },
    });
  });

  it("go out for a booking a customer makes online, with who, where and when", async () => {
    const res = await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date, hours: [9], name: "Hafiz Rahman", phone: "0195550001", email: "hafiz@example.my" }),
      })
    );
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    const sent = await alertsFor(booking.id);
    const email = sent.find((m) => m.channel === "email")!;
    expect(email).toMatchObject({ recipient: "desk@arena.my", status: "queued" });
    expect(email.subject).toContain("New booking:");
    expect(email.body).toContain("Hafiz Rahman, 0195550001");
    expect(email.body).toContain(booking.code);
    expect(email.body).toContain("to pay at the counter");
  });

  it("are not sent for a booking the venue's own staff make", async () => {
    const made = await createBooking({ courtId, date, hours: [10], name: "Walk-in", phone: "0195550002" });
    if (!made.ok) throw new Error(made.error);
    expect(await alertsFor(made.booking.id)).toEqual([]);
  });

  it("are not held to the daily limit on messages to one person", async () => {
    for (let i = 0; i < MESSAGES_PER_RECIPIENT_PER_DAY + 2; i++)
      await enqueue({
        venueId,
        kind: "venue_new_booking",
        channel: "email",
        recipient: "busy@arena.my",
        locale: "en",
        subject: "msg.venueNewBookingSubject",
        body: "msg.venueNewBooking",
        vars: { when: "x", name: "x", phone: "x", where: "x", code: `C${i}`, amount: "RM1", paid: "paid" },
      });
    const { n } = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = 'busy@arena.my' AND status = 'abandoned'")
      .get()) as { n: number };
    expect(n).toBe(0);
  });

  it("stop when the fields are emptied", async () => {
    expect(await setBookingAlerts(venueId, { email: "", phone: "" })).toEqual({ ok: true, alerts: { email: null, phone: null } });
  });
});
