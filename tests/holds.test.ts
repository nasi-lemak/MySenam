import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { holdPolicy, releaseExpiredHolds, setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { GET as availability } from "../src/app/api/availability/route";

/**
 * Paying online to hold a booking: the answer to slots lost to people who
 * never come. Held a few minutes while they pay; let go if they do not.
 */

let venueId: number;
let courtId: number;
let n = 0;
const date = addDays(todayISO(), 3);

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `holdbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

const post = (body: Record<string, unknown>) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ courtId, date, name: "Hafiz", email: "hafiz@example.my", ...body }),
    })
  );

const kinds = async (bookingId: number) =>
  ((await getDb().prepare("SELECT kind FROM messages WHERE booking_id = ?").all(bookingId)) as { kind: string }[]).map((m) => m.kind);

beforeAll(async () => {
  const made = await createVenue({ name: "No-Show Arena", area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

afterEach(() => vi.unstubAllGlobals());

describe("asking for payment to hold a booking", () => {
  it("needs a way to pay online first", async () => {
    expect(await setHoldPolicy(venueId, { on: true })).toMatchObject({ ok: false });
    const saved = await savePaymentSettings(venueId, {
      apiKey: "api-key-1234",
      collectionId: "col123",
      xSignatureKey: "S-key",
      sandbox: true,
      enabled: true,
    });
    if (!saved.ok) throw new Error(saved.error);
    expect(await setHoldPolicy(venueId, { on: true, minutes: 2 })).toMatchObject({ ok: false });
    expect(await setHoldPolicy(venueId, { on: true, minutes: 10 })).toMatchObject({ ok: true, policy: { on: true, minutes: 10, active: true } });
  });

  it("holds an online booking unpaid, and says nothing until it is paid", async () => {
    const res = await post({ hours: [9], phone: "0191110001" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.holdUntil).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(body.booking.holdUntil).toBe(body.holdUntil);
    expect(await kinds(body.booking.id)).not.toContain("booking_confirmed");

    // Paying it: the page opened, then the money in. It stands, and is confirmed.
    fakeBillplz();
    const started = await startBookingPayment({ codes: [body.booking.code], phone: "0191110001" });
    expect(started.ok).toBe(true);
    const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
    const settled = await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect(settled?.newlyPaid.map((b) => b.id)).toEqual([body.booking.id]);
    const after = (await findBooking(body.booking.code, "0191110001"))!;
    expect(after).toMatchObject({ paymentStatus: "paid", status: "confirmed", holdUntil: null });
    expect(await kinds(body.booking.id)).toContain("booking_confirmed");
    // Nobody lets go of a paid booking.
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(body.booking.id);
    await releaseExpiredHolds();
    expect((await findBooking(body.booking.code, "0191110001"))!.status).toBe("confirmed");
  });

  it("lets go of one not paid in time, and frees its slot", async () => {
    const res = await post({ hours: [10], phone: "0191110002" });
    const { booking } = await res.json();
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(booking.id);

    // Reading the day lets it go, scheduler or not.
    const grid = await (await availability(new NextRequest(`http://localhost/api/availability?venueId=${venueId}&date=${date}`))).json();
    const slot = grid.availability[0].slots.find((s: { hour: number }) => s.hour === 10);
    expect(slot.available).toBe(true);
    expect(await findBooking(booking.code, "0191110002")).toMatchObject({ status: "cancelled", releasedUnpaid: true });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM booking_slots WHERE booking_id = ?").get(booking.id)) as { n: number }).toEqual({ n: 0 });
    // Somebody else can have it.
    expect((await post({ hours: [10], phone: "0191110003" })).status).toBe(201);
  });

  it("gives somebody on the payment page more time", async () => {
    const res = await post({ hours: [11], phone: "0191110004" });
    const { booking } = await res.json();
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '+1 minutes') WHERE id = ?").run(booking.id);
    fakeBillplz();
    await startBookingPayment({ codes: [booking.code], phone: "0191110004" });
    const { ok } = (await getDb()
      .prepare("SELECT hold_until > datetime('now', '+15 minutes') AS ok FROM bookings WHERE id = ?")
      .get(booking.id)) as { ok: boolean };
    expect(ok).toBe(true);
  });

  it("does not hold a free booking, nor one staff make, nor where it is off", async () => {
    const free = await createCourt({ venueId, name: "Free court", sport: "badminton", offPeakRate: 0, peakRate: 0 });
    if (!free.ok) throw new Error("court");
    const res = await post({ courtId: free.court.id, hours: [12], phone: "0191110005" });
    expect((await res.json()).holdUntil).toBeNull();

    const counter = await createBooking({ courtId, date, hours: [13], name: "Walk-in", phone: "0191110006" });
    expect(counter.ok && counter.booking.holdUntil).toBeNull();

    await setHoldPolicy(venueId, { on: false });
    expect((await holdPolicy(venueId)).active).toBe(false);
    const res2 = await post({ hours: [14], phone: "0191110007" });
    const body = await res2.json();
    expect(body.holdUntil).toBeNull();
    expect(await kinds(body.booking.id)).toContain("booking_confirmed");
  });
});
