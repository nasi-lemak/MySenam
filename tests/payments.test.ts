import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { NextRequest } from "next/server";
import { verifyRedirect, verifyCallback, xSignature, toSen } from "../src/lib/billplz";
import { resetSecretKey, seal, unseal } from "../src/lib/secrets";
import {
  listOnlinePayments,
  markRefunded,
  paymentSettings,
  refundsOwed,
  savePaymentSettings,
  settleBill,
  startBookingPayment,
  takesPaymentOnline,
} from "../src/lib/payments";
import {
  adminCancelBooking,
  cancelBooking,
  createBooking,
  createBookingSeries,
  createVenue,
  createCourt,
  findBooking,
  listVenues,
  setPaymentStatus,
} from "../src/lib/store";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { messagesForBooking } from "../src/lib/outbox";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";
import {
  ADMIN_SESSION_COOKIE,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
} from "../src/lib/admin-auth";

/**
 * Paying online, into the venue's own Billplz account.
 *
 * Billplz is never called: fetch is stood in for, and the callbacks below are
 * signed with the test key exactly as Billplz signs them. The signature checks
 * are pinned to the example in Billplz's own documentation, so a change that
 * agrees with itself but not with Billplz still fails.
 */

const SIGNATURE_KEY = "S-test-signature-key";
const PHONE = "012-345 6789";
let venueId: number;
let courtId: number;
let otherVenueId: number;
let slot = 0;

/** A fresh hour each time, inside the booking window. */
function nextSlot(): { date: string; hour: number } {
  const n = slot++;
  return { date: addDays(todayISO(), 2 + (n % 10)), hour: 8 + Math.floor(n / 10) };
}

async function book(phone = PHONE) {
  const { date, hour } = nextSlot();
  const made = await createBooking({ courtId, date, hours: [hour], name: "Aina Zahra", phone });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

/** A Billplz that answers bill creation, recording what it was sent. */
let billNumber = 0;

function fakeBillplz() {
  const calls: { url: string; auth: string; form: URLSearchParams }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const id = `bill${++billNumber}`;
    calls.push({
      url,
      auth: (init.headers as Record<string, string>).Authorization,
      form: new URLSearchParams(init.body as string),
    });
    return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** The callback Billplz would send for a bill, signed. */
function callbackFields(billId: string, paid: boolean, key = SIGNATURE_KEY) {
  const fields: Record<string, string> = {
    id: billId,
    collection_id: "col123",
    paid: paid ? "true" : "false",
    state: paid ? "paid" : "due",
    amount: "2500",
    paid_amount: paid ? "2500" : "0",
    due_at: "2026-10-16",
    email: "",
    mobile: "60123456789",
    name: "AINA ZAHRA",
    url: `https://www.billplz-sandbox.com/bills/${billId}`,
    paid_at: paid ? "2026-10-16 10:00:00 +0800" : "",
  };
  fields.x_signature = xSignature(fields, key);
  return fields;
}

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts.find((c) => c.capacity === 1)!.id;
  const other = await createVenue({ name: "Elsewhere", area: "Klang", address: "x", phone: "0300000000" });
  if (!other.ok) throw new Error("venue");
  otherVenueId = other.venue.id;
  await createCourt({ venueId: otherVenueId, name: "Court X", sport: "badminton", offPeakRate: 10, peakRate: 20 });
});

beforeEach(async () => {
  const saved = await savePaymentSettings(venueId, {
    apiKey: "api-key-1234",
    collectionId: "col123",
    xSignatureKey: SIGNATURE_KEY,
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Billplz's signatures", () => {
  it("match the example in Billplz's documentation", () => {
    const query = new URLSearchParams({
      "billplz[id]": "zq0tm2wc",
      "billplz[paid]": "true",
      "billplz[paid_at]": "2018-09-27 15:15:09 +0800",
      "billplz[x_signature]": "4aab095fe5a39b1d534500988f9a0cb085cd1b6d5bbb55dd4e02ea6fa102b47b",
    });
    expect(verifyRedirect(query, "S-s7b4yWpp9h7rrkNM1i3Z_g")).toEqual({
      billId: "zq0tm2wc",
      paid: true,
      paidAt: "2018-09-27 15:15:09 +0800",
    });
  });

  it("refuse a redirect somebody edited to say paid", () => {
    const query = new URLSearchParams({
      "billplz[id]": "zq0tm2wc",
      "billplz[paid]": "false",
      "billplz[paid_at]": "",
    });
    query.set("billplz[x_signature]", xSignature({ billplzidzq0tm2wc: "" }, "wrong"));
    expect(verifyRedirect(query, "S-s7b4yWpp9h7rrkNM1i3Z_g")).toBeNull();
    query.set("billplz[paid]", "true");
    expect(verifyRedirect(query, "S-s7b4yWpp9h7rrkNM1i3Z_g")).toBeNull();
  });

  it("check a callback, and refuse it once anything in it changes", () => {
    const fields = callbackFields("abc", true);
    expect(verifyCallback(fields, SIGNATURE_KEY)).toMatchObject({ billId: "abc", paid: true });
    expect(verifyCallback({ ...fields, amount: "1" }, SIGNATURE_KEY)).toBeNull();
    expect(verifyCallback(fields, "another-venues-key")).toBeNull();
    expect(verifyCallback({ ...fields, x_signature: "" }, SIGNATURE_KEY)).toBeNull();
  });

  it("sort fields without regard to case, as Billplz does", () => {
    const sig = xSignature({ b: "1", A: "2" }, "k");
    expect(sig).toBe(crypto.createHmac("sha256", "k").update("A2|b1").digest("hex"));
  });

  it("count in sen", () => {
    expect(toSen(25)).toBe(2500);
    expect(toSen(12.5)).toBe(1250);
    expect(toSen(0.1 + 0.2)).toBe(30);
  });
});

describe("a venue's keys", () => {
  it("are never stored readable", async () => {
    const row = await getDb()
      .prepare("SELECT api_key, x_signature_key FROM venue_payment_accounts WHERE venue_id = ?")
      .get(venueId) as { api_key: string; x_signature_key: string };
    expect(row.api_key).not.toContain("api-key-1234");
    expect(row.x_signature_key).not.toContain(SIGNATURE_KEY);
    expect(unseal(row.api_key)).toBe("api-key-1234");
  });

  it("are never shown back, beyond the last four characters", async () => {
    const shown = await paymentSettings(venueId);
    expect(JSON.stringify(shown)).not.toContain("api-key-1234");
    expect(JSON.stringify(shown)).not.toContain(SIGNATURE_KEY);
    expect(shown).toMatchObject({ configured: true, enabled: true, sandbox: true, apiKeyEnding: "1234" });
  });

  it("can be left blank on a later save to keep them", async () => {
    const again = await savePaymentSettings(venueId, { collectionId: "col456", sandbox: false, enabled: true });
    expect(again.ok).toBe(true);
    expect(await paymentSettings(venueId)).toMatchObject({ collectionId: "col456", apiKeyEnding: "1234" });
  });

  it("must both be given the first time", async () => {
    const result = await savePaymentSettings(otherVenueId, {
      apiKey: "only-one",
      collectionId: "col1",
      sandbox: true,
      enabled: true,
    });
    expect(result.ok).toBe(false);
  });

  it("stop working, visibly, on an install with a different secret", async () => {
    const sealed = seal("hello");
    process.env.MYSENAM_SECRET = "some other machine";
    resetSecretKey();
    try {
      expect(unseal(sealed)).toBeNull();
      expect((await paymentSettings(venueId)).unreadable).toBe(true);
      expect(await takesPaymentOnline(venueId)).toBe(false);
      // …and cannot be half-updated: both keys must be typed again.
      expect(
        (await savePaymentSettings(venueId, { collectionId: "col123", sandbox: true, enabled: true })).ok
      ).toBe(false);
    } finally {
      delete process.env.MYSENAM_SECRET;
      resetSecretKey();
    }
    expect(unseal(sealed)).toBe("hello");
  });

  it("switched off means no online payment", async () => {
    await savePaymentSettings(venueId, { collectionId: "col123", sandbox: true, enabled: false });
    expect(await takesPaymentOnline(venueId)).toBe(false);
  });
});

describe("opening a payment page", () => {
  it("bills the venue's own account for what is unpaid", async () => {
    const calls = fakeBillplz();
    const booking = await book();
    const result = await startBookingPayment({ codes: [booking.code], phone: PHONE });
    expect(result).toMatchObject({ ok: true, amount: booking.totalPrice, reused: false });

    const [call] = calls;
    expect(call.url).toBe("https://www.billplz-sandbox.com/api/v3/bills");
    expect(call.auth).toBe(`Basic ${Buffer.from("api-key-1234:").toString("base64")}`);
    expect(call.form.get("collection_id")).toBe("col123");
    expect(call.form.get("amount")).toBe(String(booking.totalPrice * 100));
    expect(call.form.get("mobile")).toBe("60123456789");
    expect(call.form.get("callback_url")).toBe("https://book.example.my/api/payments/billplz/callback");
    expect(call.form.get("redirect_url")).toBe("https://book.example.my/payments/return");
    expect(call.form.get("reference_1")).toBe(booking.code);
  });

  it("sends the same page again rather than making a second bill", async () => {
    const calls = fakeBillplz();
    const booking = await book();
    const first = await startBookingPayment({ codes: [booking.code], phone: PHONE });
    const second = await startBookingPayment({ codes: [booking.code], phone: PHONE });
    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ ok: true, reused: true });
    expect(first.ok && second.ok && first.url === second.url).toBe(true);
  });

  it("pays for a whole weekly series in one bill, leaving out weeks already settled", async () => {
    const calls = fakeBillplz();
    const series = await createBookingSeries({
      courtId,
      date: addDays(todayISO(), 1),
      hours: [22],
      weeks: 3,
      name: "Aina Zahra",
      phone: PHONE,
    });
    if (!series.ok) throw new Error(series.error);
    await setPaymentStatus(series.bookings[0].code, true);
    const result = await startBookingPayment({ codes: series.bookings.map((b) => b.code), phone: PHONE });
    const expected = series.bookings[1].totalPrice + series.bookings[2].totalPrice;
    expect(result).toMatchObject({ ok: true, amount: expected });
    expect(calls[0].form.get("amount")).toBe(String(expected * 100));
  });

  it("refuses somebody else's booking", async () => {
    fakeBillplz();
    const booking = await book();
    const result = await startBookingPayment({ codes: [booking.code], phone: "0199999999" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses at a venue that takes no payment online", async () => {
    fakeBillplz();
    await savePaymentSettings(venueId, { collectionId: "col123", sandbox: true, enabled: false });
    const booking = await book();
    expect(await startBookingPayment({ codes: [booking.code], phone: PHONE })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("has nothing to do for a booking already paid, or cancelled", async () => {
    fakeBillplz();
    const paid = await book();
    await setPaymentStatus(paid.code, true);
    expect(await startBookingPayment({ codes: [paid.code], phone: PHONE })).toMatchObject({
      ok: false,
      status: 409,
    });
    const gone = await book();
    await cancelBooking(gone.code, PHONE);
    expect(await startBookingPayment({ codes: [gone.code], phone: PHONE })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("says why when Billplz turns the bill down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: ["Mobile is invalid"] } }, { status: 422 }))
    );
    const booking = await book();
    const result = await startBookingPayment({ codes: [booking.code], phone: PHONE });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(!result.ok && result.error).toMatch(/Mobile is invalid/);
  });
});

describe("being told it was paid", () => {
  async function opened() {
    fakeBillplz();
    const booking = await book();
    const result = await startBookingPayment({ codes: [booking.code], phone: PHONE });
    if (!result.ok) throw new Error(result.error);
    const billId = result.url.split("/").pop()!;
    return { booking, billId };
  }

  it("marks the booking paid online, once, however many times it is told", async () => {
    const { booking, billId } = await opened();
    const first = await settleBill({ billId, paid: true, paidAt: null });
    expect(first?.newlyPaid.map((b) => b.code)).toEqual([booking.code]);
    expect((await settleBill({ billId, paid: true, paidAt: null }))?.newlyPaid).toEqual([]);

    const now = (await findBooking(booking.code, PHONE))!;
    expect(now.paymentStatus).toBe("paid");
    expect(now.paidOnline).toBe(true);
    expect((await refundsOwed(venueId)).find((p) => p.billId === billId)).toBeUndefined();
  });

  it("changes nothing when it was not paid", async () => {
    const { booking, billId } = await opened();
    await settleBill({ billId, paid: false, paidAt: null });
    expect((await findBooking(booking.code, PHONE))!.paymentStatus).toBe("unpaid");
  });

  it("owes the money back for a booking cancelled before it arrived", async () => {
    const { booking, billId } = await opened();
    await cancelBooking(booking.code, PHONE);
    await settleBill({ billId, paid: true, paidAt: null });
    const owed = (await refundsOwed(venueId)).find((p) => p.billId === billId)!;
    expect(owed.refundOwed).toBe(booking.totalPrice);
  });

  it("owes the money back for a booking cancelled after it was paid", async () => {
    const { booking, billId } = await opened();
    await settleBill({ billId, paid: true, paidAt: null });
    await adminCancelBooking(booking.code);
    const owed = (await refundsOwed(venueId)).find((p) => p.billId === billId)!;
    expect(owed.refundOwed).toBe(booking.totalPrice);

    // Staff refund it in Billplz and say so; it stops being owed.
    expect((await markRefunded(owed.id, otherVenueId)).ok).toBe(false);
    expect((await markRefunded(owed.id, venueId)).ok).toBe(true);
    expect((await refundsOwed(venueId)).find((p) => p.billId === billId)).toBeUndefined();
    expect((await markRefunded(owed.id, venueId)).ok).toBe(false);
  });

  it("does not take a booking paid at the counter as paid twice", async () => {
    const { booking, billId } = await opened();
    await setPaymentStatus(booking.code, true);
    await settleBill({ billId, paid: true, paidAt: null });
    expect((await findBooking(booking.code, PHONE))!.paidOnline).toBe(false);
    expect((await refundsOwed(venueId)).find((p) => p.billId === billId)!.refundOwed).toBe(
      booking.totalPrice
    );
  });

  it("is listed for staff", async () => {
    const { billId } = await opened();
    expect((await listOnlinePayments(venueId)).some((p) => p.billId === billId)).toBe(true);
    expect((await listOnlinePayments(otherVenueId)).some((p) => p.billId === billId)).toBe(false);
  });
});

describe("the routes", () => {
  const callback = () => import("../src/app/api/payments/billplz/callback/route");
  const pay = () => import("../src/app/api/payments/route");

  function form(fields: Record<string, string>) {
    return new NextRequest("http://localhost/api/payments/billplz/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("a signed callback settles the booking; a forged one is turned away", async () => {
    fakeBillplz();
    const booking = await book();
    const res = await (await pay()).POST(
      new NextRequest("http://localhost/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
        body: JSON.stringify({ code: booking.code, phone: PHONE }),
      })
    );
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const billId = url.split("/").pop();

    const forged = await (await callback()).POST(form(callbackFields(billId, true, "guessed-key")));
    expect(forged.status).toBe(400);
    expect((await findBooking(booking.code, PHONE))!.paymentStatus).toBe("unpaid");

    const real = await (await callback()).POST(form(callbackFields(billId, true)));
    expect(real.status).toBe(200);
    expect((await findBooking(booking.code, PHONE))!.paidOnline).toBe(true);

    // Billplz retries: the same callback again is still a 200, and changes nothing.
    expect((await (await callback()).POST(form(callbackFields(billId, true)))).status).toBe(200);
  });

  it("a callback for a bill nobody made is turned away", async () => {
    const res = await (await callback()).POST(form(callbackFields("nope", true)));
    expect(res.status).toBe(400);
  });

  it("asks for a code and a phone", async () => {
    const res = await (await pay()).POST(
      new NextRequest("http://localhost/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: PHONE }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("staff settings never carry the keys, and stop at the venue's edge", async () => {
    await ensureBootstrapAdmin();
    const desk = await createAdmin({
      name: "Desk",
      email: "desk-payments@example.com",
      password: "desk-password",
      venueId,
    });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const mod = await import("../src/app/api/admin/venues/[id]/payment-settings/route");
    const get = async (id: number) =>
      await mod.GET(new NextRequest(`http://localhost/api/admin/venues/${id}/payment-settings`, { headers: { cookie } }), {
        params: Promise.resolve({ id: String(id) }),
      });

    const mine = await get(venueId);
    expect(mine.status).toBe(200);
    const text = await mine.text();
    expect(text).not.toContain("api-key-1234");
    expect(text).not.toContain(SIGNATURE_KEY);
    expect((await get(otherVenueId)).status).toBe(403);
  });
});

describe("the confirmation message", () => {
  it("offers paying online where the venue takes it", async () => {
    const booking = await book();
    await notifyBookingConfirmed([booking], "en", null);
    expect((await messagesForBooking(booking.id))[0].body).toContain("pay at the counter or online");

    await savePaymentSettings(venueId, { collectionId: "col123", sandbox: true, enabled: false });
    const later = await book();
    await notifyBookingConfirmed([later], "en", null);
    const body = (await messagesForBooking(later.id))[0].body;
    expect(body).toContain("pay at the counter");
    expect(body).not.toContain("or online");
  });
});
