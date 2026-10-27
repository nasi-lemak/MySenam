import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill } from "../src/lib/payments";
import { splitBooking } from "../src/lib/splits";
import { adminCancelBooking, createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as pay } from "../src/app/api/split/[token]/pay/route";

/**
 * The split-pay route (`POST /api/split/<token>/pay`): a friend with the link
 * opens the venue's payment page for one share. Refused, with nothing opened
 * at the gateway and nothing recorded, for a link that is not one, a payer
 * who gives no name or phone, a booking cancelled or every share taken; the
 * gateway's own failure is said, not hidden. Gateway: a stand-in for Stripe's
 * checkout API (the real one is in feature status' integrations).
 */

let courtId: number;
let n = 0;
let ip = 0;
const gateway: { calls: { url: string; body: string }[]; fail: boolean } = { calls: [], fail: false };

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
      if (init.method === "POST") {
        gateway.calls.push({ url, body: String(init.body) });
        if (gateway.fail) return Response.json({ error: { message: "Your card was declined." } }, { status: 402 });
        const id = `cs_test_route${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_${id}` });
    })
  );
}

/** One request from a friend's phone; each test from its own address, so the payment rate limit is its own. */
async function post(token: string, body: unknown, from = `203.0.113.${++ip}`) {
  const res = await pay(
    new NextRequest(`http://localhost/api/split/${token}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": from },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) }
  );
  return { status: res.status, body: (await res.json()) as { url?: string; amount?: number; error?: string } };
}

async function split(hour: number, parts = 3) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), 3), hours: [hour], name: "Host Tan", phone: "91234567" });
  if (!made.ok) throw new Error(made.error);
  const s = await splitBooking(made.booking.code, made.booking.phone, parts);
  if (!s.ok) throw new Error(s.error);
  return { booking: made.booking, token: s.split.token };
}

const shares = async (token: string) =>
  ((await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM online_payments op JOIN booking_splits s ON s.id = op.split_id WHERE s.token = ?")
    .get(token)) as { n: number }).n;

beforeAll(async () => {
  const made = await createVenue({ name: "Split Route Courts", area: "Bishan", address: "x", phone: "61230000" });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
  const saved = await savePaymentSettings(made.venue.id, {
    credentials: { secretKey: "rk_test_splitroute1234", webhookSecret: "whsec_splitroute12345" },
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => {
  vi.unstubAllGlobals();
  gateway.calls = [];
  gateway.fail = false;
});

describe("paying a share by the link", () => {
  it("opens the venue's payment page for one share, and records who is paying", async () => {
    fakeStripe();
    const { booking, token } = await split(8);
    const { status, body } = await post(token, { name: "  Friend One  ", phone: "91000001", email: "f1@example.sg" });
    expect(status).toBe(200);
    expect(body.amount).toBe(10);
    expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_route\d+$/);
    expect(gateway.calls).toHaveLength(1);
    // The payment page names the booking it is towards.
    expect(decodeURIComponent(gateway.calls[0].body)).toContain(booking.code);
    const row = (await getDb()
      .prepare("SELECT amount, payer_name, payer_phone, purpose, status FROM online_payments WHERE bill_id = ?")
      .get(body.url!.split("/").pop())) as Record<string, unknown>;
    expect(row).toMatchObject({ amount: 10, payer_name: "Friend One", payer_phone: "91000001", purpose: "split", status: "pending" });
  });

  it("refuses a link that is not one", async () => {
    fakeStripe();
    expect(await post("not-a-real-link", { name: "Friend", phone: "91000002" })).toEqual({ status: 404, body: { error: "That link is not valid." } });
    expect(gateway.calls).toHaveLength(0);
  });

  it("asks for a name and a phone number, and an email that looks like one, before opening anything", async () => {
    fakeStripe();
    const { token } = await split(9);
    for (const body of [{}, { name: "F", phone: "91000003" }, { name: "Friend", phone: "123" }, { name: 7, phone: 91000003 }, "not json"]) {
      const res = await post(token, body);
      expect(res, JSON.stringify(body)).toEqual({ status: 400, body: { error: "Give your name and phone number." } });
    }
    expect(await post(token, { name: "Friend", phone: "91000003", email: "not-an-email" })).toEqual({
      status: 400,
      body: { error: "That email address does not look right." },
    });
    expect(gateway.calls).toHaveLength(0);
    expect(await shares(token)).toBe(0);
  });

  it("refuses once every share is paid, and once the booking is cancelled", async () => {
    fakeStripe();
    const { token } = await split(10, 2);
    const first = await post(token, { name: "Friend Four", phone: "91000004" });
    expect(first.status).toBe(200);
    await settleBill({ billId: first.body.url!.split("/").pop()!, paid: true, paidAt: null });
    expect(await post(token, { name: "Friend Five", phone: "91000005" })).toEqual({ status: 409, body: { error: "Every share is paid already." } });

    const other = await split(11);
    expect(await adminCancelBooking(other.booking.code)).toMatchObject({ ok: true });
    expect(await post(other.token, { name: "Friend Six", phone: "91000006" })).toEqual({ status: 409, body: { error: "That booking was cancelled." } });
    expect(gateway.calls).toHaveLength(1);
  });

  it("refuses once the booking is paid in full", async () => {
    fakeStripe();
    const { booking, token } = await split(12);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(booking.id);
    expect((await findBooking(booking.code, booking.phone))!.paymentStatus).toBe("paid");
    expect(await post(token, { name: "Friend Seven", phone: "91000007" })).toEqual({
      status: 409,
      body: { error: "That booking is paid in full: settle up with the booker." },
    });
    expect(gateway.calls).toHaveLength(0);
  });

  it("says so when the gateway will not open the page, and records nothing", async () => {
    fakeStripe();
    gateway.fail = true;
    const { token } = await split(13);
    const res = await post(token, { name: "Friend Eight", phone: "91000008" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
    expect(await shares(token)).toBe(0);
  });

  it("is limited per address like any payment page", async () => {
    fakeStripe();
    const { token } = await split(14, 10);
    const from = "198.51.100.77";
    const answers: number[] = [];
    for (let i = 0; i < 11; i++) answers.push((await post(token, { name: `Friend ${i}`, phone: `9200000${i}` }, from)).status);
    expect(answers.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(answers[10]).toBe(429);
    expect(gateway.calls).toHaveLength(10);
  });
});
