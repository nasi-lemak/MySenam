import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { notifyBookingCancelled, notifyRefundStates, tickOutbox } from "../src/lib/notify";
import { enqueue, messagesForBooking, setTransport, type OutboxMessage } from "../src/lib/outbox";
import { markRefunded, refundCancelled, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { cancelBooking, createBookingSeries, createCourt, createVenue, adminCancelBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Audit 9, G13: the customer is told when money they paid comes back, fails to, is late, or is the venue's to send by a date: once per
 * change, in the language they booked in, never held to the day's limit. Nothing here reaches a payment provider: fetch is stood in for.
 */
let venueId: number;
let courtId: number;
let n = 0;
let slot = 0;
const sent: OutboxMessage[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds")) return Response.json({ id: `re_${++n}`, status: "succeeded" });
      if (init.method === "POST") {
        const id = `cs_test_notice${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

beforeAll(async () => {
  const made = await createVenue({ name: "Notice Courts", area: "PJ", address: "x", phone: "61234550" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, {
    credentials: { secretKey: "rk_test_abcdefghijklmnop", webhookSecret: "whsec_testsecret1234567890" },
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  expect((await setCancelPolicy(venueId, { onlineRefunds: "staff", refundWithinDays: 3 })).ok).toBe(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTransport(null);
  sent.length = 0;
});

/** A booking paid online, with the customer's email; the language is the booking's. */
async function paid(locale = "en", email: string | null = `refund${++n}@example.my`) {
  fakeStripe();
  const i = slot++;
  const made = await createBookingSeries({
    courtId,
    date: addDays(todayISO(), 3 + (i % 6)),
    hours: [9 + Math.floor(i / 6)],
    name: "Wei Ling",
    phone: `9123${String(++n).padStart(4, "0")}`,
    ...(email ? { email } : {}),
    weeks: 1,
  });
  if (!made.ok) throw new Error(made.error);
  const booking = made.bookings[0];
  await getDb().prepare("UPDATE bookings SET locale = ? WHERE id = ?").run(locale, booking.id);
  const started = await startBookingPayment({ codes: [booking.code], phone: booking.phone });
  if (!started.ok) throw new Error("payment");
  await settleBill({ billId: started.url.split("/").pop()!, paid: true, paidAt: null });
  const paymentId = ((await getDb().prepare("SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?").get(booking.id)) as { payment_id: number }).payment_id;
  return { booking, paymentId };
}

const notices = async (bookingId: number) => (await messagesForBooking(bookingId)).filter((m) => m.kind === "refund_notice" && m.channel === "email");

describe("what the customer is told about a refund", () => {
  it("is told the date when the venue must make it by hand, once, and not again however often it is looked at", async () => {
    const { booking, paymentId } = await paid();
    expect((await cancelBooking(booking.code, booking.phone)).ok).toBe(true);
    await refundCancelled([booking.id]);
    expect(await notifyRefundStates()).toBe(1);
    expect(await notifyRefundStates()).toBe(0);
    const [told] = await notices(booking.id);
    expect(told.subject).toContain(`Your refund for booking ${booking.code}`);
    expect(told.body).toMatch(/The venue will refund the S\$20/);
    expect(told.body).toContain(booking.code);
    expect(told.dedupeKey).toBe(`refund:${paymentId}:owed:20.00`);
    await markRefunded(paymentId, venueId, null, "DBS transfer 1");
    await notifyRefundStates(); // (its "made" notice, so the next test starts clean)
  });

  it("is not told the date twice by a customer who cancelled themselves and was told it in the cancellation message", async () => {
    const { booking, paymentId } = await paid();
    const done = await cancelBooking(booking.code, booking.phone);
    if (!done.ok) throw new Error("cancel");
    const refunds = await refundCancelled([booking.id]);
    await notifyBookingCancelled(done.booking, "en", { refunds });
    await notifyRefundStates();
    expect(await notices(booking.id)).toEqual([]);
    await markRefunded(paymentId, venueId, null, "DBS transfer 2");
    await notifyRefundStates();
  });

  it("is told when it is late, then, once it is made, that it was made, each once", async () => {
    const { booking, paymentId } = await paid();
    expect((await cancelBooking(booking.code, booking.phone)).ok).toBe(true);
    await refundCancelled([booking.id]);
    await notifyRefundStates();
    await getDb().prepare("UPDATE online_payments SET refund_seen_at = ?, refund_seen_policy = 'manual' WHERE id = ?").run(
      new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 19).replace("T", " "),
      paymentId
    );
    expect(await notifyRefundStates()).toBe(1);
    expect(await notifyRefundStates()).toBe(0);
    expect((await notices(booking.id)).at(-1)!.subject).toContain("is late");
    expect((await notices(booking.id)).at(-1)!.body).toContain("has not marked it refunded yet");

    expect(await markRefunded(paymentId, venueId, null, "DBS transfer 3")).toMatchObject({ ok: true });
    expect(await notifyRefundStates()).toBe(1);
    expect(await notifyRefundStates()).toBe(0);
    const made = (await notices(booking.id)).at(-1)!;
    expect(made.subject).toContain("Refund made");
    expect(made.body).toMatch(/S\$20 refunded on \d{4}-\d{2}-\d{2}/);
    expect(made.dedupeKey).toBe(`refund:${paymentId}:completed:20.00`);
    expect(await notices(booking.id)).toHaveLength(3);
  });

  it("is told when the payment provider could not make it, and not while it is only asked or settling", async () => {
    const { booking, paymentId } = await paid();
    expect((await cancelBooking(booking.code, booking.phone)).ok).toBe(true);
    await refundCancelled([booking.id]);
    await notifyRefundStates();
    const before = (await notices(booking.id)).length;
    await getDb().prepare("INSERT INTO online_refunds (payment_id, amount, provider_ref, pending) VALUES (?, 20, ?, 0)").run(paymentId, `claim:${paymentId}:1`);
    expect(await notifyRefundStates()).toBe(0);
    await getDb().prepare("UPDATE online_refunds SET provider_ref = 're_pending_9', pending = 1 WHERE payment_id = ?").run(paymentId);
    expect(await notifyRefundStates()).toBe(0);
    await getDb().prepare("UPDATE online_refunds SET pending = 0, failed_at = datetime('now') WHERE payment_id = ?").run(paymentId);
    expect(await notifyRefundStates()).toBe(1);
    expect(await notifyRefundStates()).toBe(0);
    const failed = (await notices(booking.id)).at(-1)!;
    expect(failed.subject).toContain("Problem with your refund");
    expect(failed.body).toContain("could not refund");
    expect((await notices(booking.id)).length).toBe(before + 1);
    await markRefunded(paymentId, venueId, null, "after failure");
  });

  it("is told that a refund the venue cancelled is made through the provider, once, through the tick", async () => {
    const { booking } = await paid();
    expect((await setCancelPolicy(venueId, { onlineRefunds: "gateway" })).ok).toBe(true);
    expect((await adminCancelBooking(booking.code)).ok).toBe(true);
    await refundCancelled([booking.id], { byVenue: true });
    setTransport({ name: "recorder", async send(m) { sent.push(m); } });
    await tickOutbox();
    await tickOutbox();
    expect(await notices(booking.id)).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "refund_notice" && m.bookingId === booking.id)).toHaveLength(1);
    expect((await notices(booking.id))[0].subject).toContain("Refund made");
    expect((await setCancelPolicy(venueId, { onlineRefunds: "staff" })).ok).toBe(true);
  });

  it("is written in the language the booking was made in", async () => {
    for (const [locale, expected] of [["ms", "Bayaran balik dibuat"], ["zh", "退款已办理"], ["ta", "பணம் திருப்பித் தரப்பட்டது"]] as const) {
      const { booking, paymentId } = await paid(locale);
      expect((await cancelBooking(booking.code, booking.phone)).ok).toBe(true);
      await refundCancelled([booking.id]);
      await markRefunded(paymentId, venueId, null, `ref ${locale}`);
      await notifyRefundStates();
      const made = (await notices(booking.id)).find((m) => m.dedupeKey?.includes(":completed:"))!;
      expect(made.locale).toBe(locale);
      expect(made.subject).toContain(expected);
      expect(made.body).not.toMatch(/\{\w+\}/);
    }
  });

  it("is not held to the day's limit: a customer with eight messages today is still told", async () => {
    const { booking, paymentId } = await paid("en", "capped.refund@example.my");
    for (let i = 0; i < 8; i++)
      await enqueue({ venueId, kind: "booking_reminder", channel: "email", recipient: "capped.refund@example.my", subject: "msg.reminderSubject", body: "msg.reminder", vars: { name: "B", code: `R${i}`, where: "c", when: "w", link: "l" } });
    expect((await cancelBooking(booking.code, booking.phone)).ok).toBe(true);
    await refundCancelled([booking.id]);
    await markRefunded(paymentId, venueId, null, "capped");
    await notifyRefundStates();
    expect((await notices(booking.id)).at(-1)).toMatchObject({ status: "queued" });
  });

  it("tells nobody who left no email, and nothing about a refund an old install made long ago", async () => {
    const none = await paid("en", null);
    expect((await cancelBooking(none.booking.code, none.booking.phone)).ok).toBe(true);
    await refundCancelled([none.booking.id]);
    await markRefunded(none.paymentId, venueId, null, "no email");
    const old = await paid();
    expect((await cancelBooking(old.booking.code, old.booking.phone)).ok).toBe(true);
    await refundCancelled([old.booking.id]);
    await markRefunded(old.paymentId, venueId, null, "long ago");
    await getDb().prepare("UPDATE online_refunds SET created_at = datetime('now', '-10 days') WHERE payment_id = ?").run(old.paymentId);
    await notifyRefundStates();
    expect(await notices(none.booking.id)).toEqual([]);
    expect((await notices(old.booking.id)).filter((m) => m.dedupeKey?.includes(":completed:"))).toEqual([]);
  });
});
