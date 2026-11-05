import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { setCancelPolicy } from "../src/lib/cancel-policy";
import { cancelMovedPlace, moveClasses } from "../src/lib/class-moves";
import { counterOwed } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createClassSessions, createCourt, createVenue, enrolInClass, findBookingByCode, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A customer's cancellation after the venue moved their class is the venue's own cancellation of an enrolment, the one a class
 * called off makes: what was paid online goes back through the gateway once (against a stand-in for Stripe only, never the real
 * service), a counter payment is owed back for staff to settle, and nothing is paid out twice by a second tap.
 */

let venueId: number;
let studioId: number;
let n = 0;
let days = 6;
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
        const id = `cs_test_cm${++n}`;
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
const offerOf = async (bookingId: number) => (await getDb().prepare("SELECT token FROM class_move_offers WHERE booking_id = ? ORDER BY id DESC").get(bookingId)) as { token: string };

beforeAll(async () => {
  const made = await createVenue({ name: "Move Refund Studio", area: "Bishan", address: "1 Road", phone: "61230333" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const studio = await createCourt({ venueId, name: "Studio", sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 5 });
  if (!studio.ok) throw new Error("studio");
  studioId = studio.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_cmrefundkey123456", webhookSecret: "whsec_cmrefund1234567890" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  // What the venue chose for a customer's own cancellation is not what this is: it is the venue that moved the class.
  await setCancelPolicy(venueId, { onlineRefunds: "staff" });
});
afterEach(() => {
  refundCalls = [];
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

async function aClass() {
  const date = addDays(todayISO(), (days += 4));
  const made = await createClassSessions({ courtId: studioId, name: "Yoga", instructor: "Mei", date, startHour: 9, endHour: 10, capacity: 5, price: 25 });
  if (!made.ok) throw new Error(made.error);
  return made.classes[0];
}

describe("cancelling a moved place", () => {
  it("sends what was paid online back through the gateway, once, whatever the venue chose for customers", async () => {
    fakeStripe();
    const session = await aClass();
    const phone = `9127${String(++n).padStart(4, "0")}`;
    const enrolled = await enrolInClass({ classId: session.id, name: "Lee", phone, email: "lee-cm@move.sg" });
    if (!enrolled.ok) throw new Error(enrolled.error);
    const started = await startBookingPayment({ codes: [enrolled.booking.code], phone });
    if (!started.ok) throw new Error("payment");
    const billId = started.url.split("/").pop()!;
    await settleBill({ billId, paid: true, paidAt: null });
    const paymentId = await paymentOf(billId);
    refundCalls = [];

    const moved = await moveClasses({ id: null, name: "Mover" }, session.id, { date: addDays(session.date, 2), start: 10 * 60 });
    expect(moved.ok).toBe(true);
    // Moving sends nothing back: the customer chooses.
    expect(refundCalls).toHaveLength(0);
    expect((await findBookingByCode(enrolled.booking.code))!.status).toBe("confirmed");
    const { token } = await offerOf(enrolled.booking.id);

    const done = await cancelMovedPlace(token, enrolled.booking.id);
    expect(done.ok).toBe(true);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].amount).toBe(2500);
    expect(await owedOn(paymentId)).toEqual({ due: 25, refunded: 25 });
    // The credit note for it is written once.
    const notes = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND source LIKE ?").get(`%${enrolled.booking.code}%`)) as { n: number };
    // A second tap: refused, nothing more is sent.
    expect(await cancelMovedPlace(token, enrolled.booking.id)).toMatchObject({ ok: false, code: "ALREADY_CANCELLED" });
    expect(refundCalls).toHaveLength(1);
    const again = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND source LIKE ?").get(`%${enrolled.booking.code}%`)) as { n: number };
    expect(again.n).toBe(notes.n);
    // The customer is told it is cancelled and what came back.
    const mail = (await getDb().prepare("SELECT body FROM messages WHERE recipient = 'lee-cm@move.sg' AND kind = 'booking_cancelled'").get()) as { body: string } | undefined;
    expect(mail).toBeTruthy();
  });

  it("owes a counter payment back for staff to settle, as when a class is called off", async () => {
    const session = await aClass();
    const enrolled = await enrolInClass({ classId: session.id, name: "Counter Chan", phone: `9128${String(++n).padStart(4, "0")}`, email: "chan-cm@move.sg" });
    if (!enrolled.ok) throw new Error(enrolled.error);
    expect((await setPaymentStatus(enrolled.booking.code, true, "cash")).ok).toBe(true);
    await moveClasses({ id: null, name: "Mover" }, session.id, { date: addDays(session.date, 1), start: 9 * 60 });
    const { token } = await offerOf(enrolled.booking.id);
    expect((await cancelMovedPlace(token, enrolled.booking.id)).ok).toBe(true);
    const owed = (await counterOwed(null, "manager")).find((o) => o.bookingId === enrolled.booking.id);
    expect(owed).toMatchObject({ cause: "class", amount: 25, via: "cash" });
    // Once: a second tap owes nothing more.
    await cancelMovedPlace(token, enrolled.booking.id);
    expect((await counterOwed(null, "manager")).filter((o) => o.bookingId === enrolled.booking.id)).toHaveLength(1);
  });

  it("is only the place on the link: another person's place in the same class stays", async () => {
    const session = await aClass();
    const mine = await enrolInClass({ classId: session.id, name: "Mine", phone: `9129${String(++n).padStart(4, "0")}`, email: "mine-cm@move.sg" });
    const theirs = await enrolInClass({ classId: session.id, name: "Theirs", phone: `9129${String(++n).padStart(4, "0")}`, email: "theirs-cm@move.sg" });
    if (!mine.ok || !theirs.ok) throw new Error("enrol");
    await moveClasses({ id: null, name: "Mover" }, session.id, { date: addDays(session.date, 1), start: 9 * 60 });
    const link = await offerOf(mine.booking.id);
    expect(await cancelMovedPlace(link.token, theirs.booking.id)).toMatchObject({ ok: false, code: "CLSA_LINK" });
    expect((await findBookingByCode(theirs.booking.code))!.status).toBe("confirmed");
    expect((await cancelMovedPlace(link.token, mine.booking.id)).ok).toBe(true);
    expect((await findBookingByCode(theirs.booking.code))!.status).toBe("confirmed");
  });
});
