import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { NextRequest } from "next/server";
import { documentFor } from "../src/lib/documents";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startBookingPayment, startSplitPayment } from "../src/lib/payments";
import { splitBooking, splitByToken } from "../src/lib/splits";
import { adminCancelBooking, cancelBooking, createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { addDays, todayISO } from "../src/lib/time";
import { POST as splitRoute } from "../src/app/api/bookings/split/route";

/**
 * Splitting a booking with friends: each pays a share to the venue online
 * through a link, towards the booking; the booker pays the rest; shares are
 * owed back if the booking goes, or if they came in once every share was taken.
 */

let venueId: number;
let courtId: number;
let plainCourtId: number;
let n = 0;

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (init.method === "POST") {
        const id = `cs_test_split${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_${id}` });
    })
  );
}

const billOf = (url: string) => url.split("/").pop()!;
const friend = (i: number) => ({ name: `Friend ${i}`, phone: `9100000${i}`, email: `f${i}@example.sg` });

async function booking(hour: number, onCourt = courtId) {
  const made = await createBooking({ courtId: onCourt, date: addDays(todayISO(), 3), hours: [hour], name: "Host Tan", phone: "91234567" });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

beforeAll(async () => {
  const made = await createVenue({ name: "Split Courts", area: "Bishan", address: "x", phone: "61230000" });
  const plain = await createVenue({ name: "Cash Only", area: "Bishan", address: "x", phone: "61230001" });
  if (!made.ok || !plain.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  const other = await createCourt({ venueId: plain.venue.id, name: "C", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok || !other.ok) throw new Error("court");
  courtId = court.court.id;
  plainCourtId = other.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_splitkey12345678", webhookSecret: "whsec_split123456789" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("splitting", () => {
  it("is for an unpaid booking at a venue taking payment online, 2 to 10 ways", async () => {
    const b = await booking(8);
    expect(await splitBooking(b.code, b.phone, 1)).toMatchObject({ ok: false });
    expect(await splitBooking(b.code, "99999999", 3)).toMatchObject({ ok: false, status: 404 });
    const cash = await booking(8, plainCourtId);
    expect(await splitBooking(cash.code, cash.phone, 3)).toMatchObject({ ok: false, status: 409 });
    const res = await splitRoute(
      new NextRequest("http://localhost/api/bookings/split", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: b.code, phone: b.phone, parts: 3 }),
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.split).toMatchObject({ parts: 3, share: 10, paid: 0 });
    expect(data.url).toMatch(/^https:\/\/book\.example\.sg\/split\/[\w-]+$/);
  });

  it("friends pay their shares towards the booking, and the booker the rest", async () => {
    fakeStripe();
    const b = await booking(9);
    const made = await splitBooking(b.code, b.phone, 3);
    if (!made.ok) throw new Error(made.error);
    const token = made.split.token;
    for (const i of [1, 2]) {
      const started = await startSplitPayment(token, friend(i));
      if (!started.ok) throw new Error(started.error);
      expect(started.amount).toBe(10);
      await settleBill({ billId: billOf(started.url), paid: true, paidAt: null });
    }
    expect((await findBooking(b.code, b.phone))!).toMatchObject({ sharesPaid: 20, paymentStatus: "unpaid" });
    expect(await splitByToken(token)).toMatchObject({ paid: 2, closed: "full" });
    expect(await startSplitPayment(token, friend(3))).toMatchObject({ ok: false, status: 409 });
    const host = await startBookingPayment({ codes: [b.code], phone: b.phone });
    expect(host).toMatchObject({ ok: true, amount: 10 });
    const share = (await getDb().prepare("SELECT id FROM online_payments WHERE purpose = 'split' AND payer_name = 'Friend 1' ORDER BY id DESC LIMIT 1").get()) as { id: number };
    expect(await documentFor(`payment:${share.id}`)).toMatchObject({ kind: "receipt", total: 10 });
  });

  it("a share that arrives after every share was taken is owed back", async () => {
    fakeStripe();
    const b = await booking(10);
    const made = await splitBooking(b.code, b.phone, 2);
    if (!made.ok) throw new Error(made.error);
    const one = await startSplitPayment(made.split.token, friend(4));
    const two = await startSplitPayment(made.split.token, friend(5));
    if (!one.ok || !two.ok) throw new Error("start");
    await settleBill({ billId: billOf(one.url), paid: true, paidAt: null });
    await settleBill({ billId: billOf(two.url), paid: true, paidAt: null });
    const late = (await getDb().prepare("SELECT id, refund_due FROM online_payments WHERE payer_name = 'Friend 5'").get()) as { id: number; refund_due: string };
    expect(Number(late.refund_due)).toBe(15);
    expect((await findBooking(b.code, b.phone))!.sharesPaid).toBe(15);
    expect(await documentFor(`credit:${(await documentFor(`payment:${late.id}`))!.id}`)).toMatchObject({ kind: "credit_note" });
  });

  it("can be changed until a friend pays; cancelling the booking owes every share back", async () => {
    fakeStripe();
    const b = await booking(11);
    expect(await splitBooking(b.code, b.phone, 2)).toMatchObject({ ok: true });
    const again = await splitBooking(b.code, b.phone, 3);
    if (!again.ok) throw new Error(again.error);
    expect(again.split.share).toBe(10);
    const started = await startSplitPayment(again.split.token, friend(6));
    if (!started.ok) throw new Error(started.error);
    await settleBill({ billId: billOf(started.url), paid: true, paidAt: null });
    expect(await splitBooking(b.code, b.phone, 4)).toMatchObject({ ok: false });
    expect(await adminCancelBooking(b.code)).toMatchObject({ ok: true });
    const paid = (await getDb().prepare("SELECT id, refund_due FROM online_payments WHERE payer_name = 'Friend 6'").get()) as { id: number; refund_due: string };
    expect(Number(paid.refund_due)).toBe(10);
    expect(await splitByToken(again.split.token)).toMatchObject({ closed: "cancelled" });
  });

  it("on a late cancellation, refunds friends what the booker gets back, so the venue keeps its fee on the whole", async () => {
    fakeStripe();
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 120 WHERE id = ?").run(venueId);
    await setCancelPolicy(venueId, { lateKeep: 50 });
    const b = await booking(12);
    const made = await splitBooking(b.code, b.phone, 3);
    if (!made.ok) throw new Error(made.error);
    const started = await startSplitPayment(made.split.token, friend(7));
    if (!started.ok) throw new Error(started.error);
    await settleBill({ billId: billOf(started.url), paid: true, paidAt: null });
    expect(await cancelBooking(b.code, b.phone)).toMatchObject({ ok: true });
    const paid = (await getDb().prepare("SELECT id, refund_due FROM online_payments WHERE payer_name = 'Friend 7'").get()) as { id: number; refund_due: string };
    expect(Number(paid.refund_due)).toBe(5);
    const receipt = (await documentFor(`payment:${paid.id}`))!;
    expect(await documentFor(`credit:${receipt.id}`)).toMatchObject({ kind: "credit_note", total: 5, note: "receipt.why.lateCancelled" });
    await setCancelPolicy(venueId, {});
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 2 WHERE id = ?").run(venueId);
  });
});
