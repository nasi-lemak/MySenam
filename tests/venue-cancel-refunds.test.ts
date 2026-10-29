import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { cancelClassAndTell } from "../src/lib/notify";
import { createOutage } from "../src/lib/outages";
import { refundOwedByVenue, refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createBooking, createClassSessions, createCourt, createVenue, enrolInClass, findBookingByCode } from "../src/lib/store";
import { cancelTournament, createTournament, enter } from "../src/lib/tournaments";
import { addDays, todayISO } from "../src/lib/time";

/**
 * One policy for what the venue cancels (owner's decision, 29 October 2026): a court out of service, a class called
 * off and a tournament called off send what was paid online back through the gateway wherever it can refund, whatever
 * the venue chose for a customer's own cancellation; where it cannot, the money stays owed for staff, listed with the
 * date it is due. Once: asked again, nothing more is sent. Against a stand-in for Stripe only.
 */

let venueId: number;
let courtId: number;
let studioId: number;
let ownerId: number;
let n = 0;
let days = 10;
let refundCalls: { key: string; amount: number }[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds")) {
        const form = new URLSearchParams(init.body ?? "");
        refundCalls.push({ key: form.get("metadata[mysenam_key]") ?? "", amount: Number(form.get("amount")) });
        return Response.json({ id: `re_${++n}`, status: "succeeded" });
      }
      if (init.method === "POST") {
        const id = `cs_test_vc${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

const owedOn = async (paymentId: number) =>
  (await getDb().prepare("SELECT refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(paymentId)) as { due: number; refunded: number };
const paymentOf = async (billId: string) => ((await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(billId)) as { id: number }).id;

beforeAll(async () => {
  const made = await createVenue({ name: "Policy Courts", area: "Bishan", address: "x", phone: "61230222" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const studio = await createCourt({ venueId, name: "Studio", sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 5 });
  if (!studio.ok) throw new Error("studio");
  studioId = studio.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_vcrefundkey123456", webhookSecret: "whsec_vcrefund1234567890" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const admin = await createAdmin({ name: "Mgr", email: "mgr@vcrefund.sg", password: "long enough password", venueId });
  if (!admin.ok) throw new Error("admin");
  ownerId = admin.admin.id;
  // The venue's own setting is for a customer's cancellation: leaving the money to staff is what it chose.
  await setCancelPolicy(venueId, { onlineRefunds: "staff" });
});

afterEach(() => {
  refundCalls = [];
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("what the venue cancels is refunded through the gateway, whatever the venue chose for customers", () => {
  it("a court taken out of service: the booking's online payment goes back at once, once", async () => {
    fakeStripe();
    const date = addDays(todayISO(), days++);
    const phone = `9125${String(++n).padStart(4, "0")}`;
    const made = await createBooking({ courtId, date, hours: [10], name: "Wei Ling", phone });
    if (!made.ok) throw new Error(made.error);
    const started = await startBookingPayment({ codes: [made.booking.code], phone });
    if (!started.ok) throw new Error("payment");
    const billId = started.url.split("/").pop()!;
    await settleBill({ billId, paid: true, paidAt: null });
    const paymentId = await paymentOf(billId);
    refundCalls = [];

    const out = await createOutage({ courtId, startsOn: date, endsOn: date, reason: "Floor", adminId: ownerId, cancelAffected: true });
    expect(out.ok).toBe(true);
    expect((await findBookingByCode(made.booking.code))!.status).toBe("cancelled");
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].amount).toBe(2000);
    expect(await owedOn(paymentId)).toEqual({ due: 20, refunded: 20 });
    expect((await refundsOwed(venueId)).some((p) => p.id === paymentId)).toBe(false);
    // Asked again (a retry): nothing more is owed, nothing more is sent.
    await refundOwedByVenue([paymentId]);
    expect(refundCalls).toHaveLength(1);
  });

  it("a class called off: each enrolment's online payment goes back", async () => {
    fakeStripe();
    const date = addDays(todayISO(), days++);
    const made = await createClassSessions({ courtId: studioId, name: "Yoga", instructor: "Mei", date, startHour: 9, endHour: 10, capacity: 5, price: 25 });
    if (!made.ok) throw new Error(made.error);
    const phone = `9126${String(++n).padStart(4, "0")}`;
    const enrolled = await enrolInClass({ classId: made.classes[0].id, name: "Lee", phone });
    if (!enrolled.ok) throw new Error(enrolled.error);
    const started = await startBookingPayment({ codes: [enrolled.booking.code], phone });
    if (!started.ok) throw new Error("payment");
    const billId = started.url.split("/").pop()!;
    await settleBill({ billId, paid: true, paidAt: null });
    const paymentId = await paymentOf(billId);
    refundCalls = [];

    const off = await cancelClassAndTell(made.classes[0].id);
    expect(off.ok).toBe(true);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].amount).toBe(2500);
    expect(await owedOn(paymentId)).toEqual({ due: 25, refunded: 25 });
  });

  it("a tournament called off: each entry fee paid online goes back", async () => {
    fakeStripe();
    const day = addDays(todayISO(), days++);
    const t = await createTournament(
      { venueId, name: "Policy Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 20, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: [courtId] },
      ownerId
    );
    if (!t.ok) throw new Error(t.error);
    const player = await registerUser({ name: "Player", email: `vc${++n}@cup.my`, phone: `0135${String(n).padStart(6, "0")}`, password: "a long enough password" });
    if (!player.ok) throw new Error(player.error);
    const entered = await enter(player.user, t.value.id);
    if (!entered.ok) throw new Error(entered.error);
    await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, purpose, tournament_entry_id)
         VALUES ('stripe', 'cs_test_vcentry', 'https://x', ?, 20, 'paid', 'Player', 'entry', ?)`
      )
      .run(venueId, entered.value.id);
    const paymentId = await paymentOf("cs_test_vcentry");
    refundCalls = [];

    expect((await cancelTournament(t.value.id)).ok).toBe(true);
    expect(refundCalls).toHaveLength(1);
    expect(await owedOn(paymentId)).toEqual({ due: 20, refunded: 20 });
  });

  it("where the gateway has no refund API the money stays owed for staff, listed with its due date, and is never reported refunded", async () => {
    await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, purpose, refund_due)
         VALUES ('billplz', 'bp_vc_manual', 'https://x', ?, 30, 'paid', 'Manual', 'booking', 30)`
      )
      .run(venueId);
    const paymentId = await paymentOf("bp_vc_manual");
    const done = await refundOwedByVenue([paymentId]);
    expect(done).toEqual([{ how: "staff", amount: 30, dueBy: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect(await owedOn(paymentId)).toEqual({ due: 30, refunded: 0 });
    expect((await refundsOwed(venueId)).some((p) => p.id === paymentId)).toBe(true);
    expect(refundCalls).toHaveLength(0);
  });
});
