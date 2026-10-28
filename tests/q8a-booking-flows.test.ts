import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { bookingLinkPath, bookingLinkToken, checkBookingLink, linkExpiry, LINK_MIN_DAYS, phoneForLink } from "../src/lib/booking-access";
import { bookingTerms } from "../src/lib/booking-terms";
import { cancelPolicy, setCancelPolicy, strikesFor } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { setHoldPolicy } from "../src/lib/holds";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { decodePending, safeNext, signInWithIdentity } from "../src/lib/oauth";
import { savePaymentSettings } from "../src/lib/payments";
import { resetRateLimits } from "../src/lib/rate-limit";
import { safePath, signInError } from "../src/lib/safe-path";
import {
  accountHasBooking,
  cancelBooking,
  cancelUserBooking,
  createBooking,
  createClassSessions,
  createCourt,
  createPromoCode,
  createVenue,
  joinSlotWaitlist,
  listUserBookings,
  listVenues,
  listWaitlistFor,
  setPaymentStatus,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { describeOffer } from "../src/lib/waitlist-offer";
import { GET as lookup } from "../src/app/api/bookings/route";
import { POST as pay } from "../src/app/api/payments/route";
import { GET as offerRoute, POST as claimRoute } from "../src/app/api/waitlist/claim/route";
import { GET as myBookings } from "../src/app/api/my/bookings/route";
import { POST as myCancel } from "../src/app/api/my/bookings/cancel/route";
import { GET as quote } from "../src/app/api/quote/route";
import { POST as enrol } from "../src/app/api/classes/enrol/route";

/**
 * The customer's booking and payment flows (audit R8 X2): where sign-in may
 * send a browser next, links that open a booking, a waiting-list offer seen
 * before it is claimed and held after it, the account's bookings (held ones
 * as held, guest ones under a proved address), a promo code checked before
 * booking, a class paid online, and giving a court back late.
 */

let n = 0;
const phone = () => `0136${String(++n).padStart(6, "0")}`;
const get = (url: string, cookie?: string) => new NextRequest(url, cookie ? { headers: { cookie } } : undefined);
const postJson = (url: string, body: unknown, cookie?: string) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** A venue of its own, with a court (a studio of `capacity` places), taking payment online through the Billplz stand-in. */
async function venueWithCourt(name: string, online = false, capacity = 1) {
  const made = await createVenue({ name, area: "PJ", address: "1 Jalan", phone: "0300000000" });
  if (!made.ok) throw new Error(made.error);
  const venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = now() WHERE id = ?").run(venueId);
  const court = await createCourt({ venueId, name: "Court 1", sport: capacity > 1 ? "gym" : "badminton", offPeakRate: 20, peakRate: 20, capacity });
  if (!court.ok) throw new Error(court.error);
  if (online) {
    const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
  }
  return { venueId, courtId: court.court.id };
}

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `q8abill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

beforeEach(() => resetRateLimits());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("where signing in sends the browser next (X2-1)", () => {
  it("keeps a page on this site, as it was asked for", () => {
    for (const ok of ["/account", "/venue/1?date=2026-11-01", "/games?game=3&link=abc", "/my-booking#top", "/a/b%20c"])
      expect(safePath(ok)).toBe(ok);
    expect(safePath("/a/../b")).toBe("/b");
  });

  it("refuses every way of naming another site, the audit's included", () => {
    const bad = [
      null,
      "",
      "https://evil.example",
      "javascript:alert(1)",
      "evil.example",
      "//evil.example",
      "/\\evil.example",
      "/%5Cevil.example/x",
      "/%5cevil.example",
      "/\tevil.example",
      "/\t/evil.example",
      "/%09/evil.example",
      "/\n/evil.example",
      "/%0A/evil.example",
      "/\r/evil.example",
      "/%0d/evil.example",
      "/%00/evil.example",
      "/%2F/evil.example",
      "/%2f%2fevil.example",
      "%2F%2Fevil.example",
      "/%252F/evil.example",
      "/%25252F/evil.example",
      "/%2525252F/evil.example",
      " //evil.example",
      "/\u0085/evil.example",
      "/%E0%A4%A",
      `/${"a".repeat(600)}`,
    ];
    for (const next of bad) {
      expect(safePath(next), String(next)).toBe("/account");
      expect(safeNext(next), String(next)).toBe("/account");
    }
    expect(safePath("//evil.example", "/")).toBe("/");
  });

  it("Google sign-in keeps only a page on this site to come back to", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-123.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh");
    vi.stubEnv("MYSENAM_URL", "https://mysenam.my");
    const start = await import("../src/app/api/auth/google/route");
    for (const [asked, kept] of [
      ["/%09/evil.example", "/account"],
      ["/%5Cevil.example", "/account"],
      ["%2F%2Fevil.example", "/account"],
      ["/games", "/games"],
    ]) {
      resetRateLimits();
      const off = await start.GET(new NextRequest(`https://mysenam.my/api/auth/google?next=${encodeURIComponent(asked)}`, { headers: { host: "mysenam.my" } }));
      expect(decodePending(off.cookies.get("ms_oauth")!.value)!.next, asked).toBe(kept);
    }
  });

  it("a refused Google sign-in comes back with a code the page has words for, never the text", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-123.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh");
    vi.stubEnv("MYSENAM_URL", "https://mysenam.my");
    const back = await import("../src/app/api/auth/google/callback/route");
    const failed = await back.GET(get("https://mysenam.my/api/auth/google/callback?code=c&state=nope"));
    expect(failed.headers.get("location")).toBe("https://mysenam.my/login?error=expired");
    const cancelled = await back.GET(get("https://mysenam.my/api/auth/google/callback?error=access_denied"));
    expect(cancelled.headers.get("location")).toBe("https://mysenam.my/login?error=cancelled");
  });

  it("the sign-in page shows only known codes: anything else is the general failure", () => {
    for (const code of ["cancelled", "unverified", "expired", "noemail", "unavailable", "google"]) expect(signInError(code)).toBe(code);
    expect(signInError("Your account is locked. Call 012-999 9999")).toBe("google");
    expect(signInError(null)).toBeNull();
    expect(signInError("")).toBeNull();
  });
});

describe("links that open a booking on My Booking (X2-8)", () => {
  let courtId: number;
  beforeAll(async () => {
    ({ courtId } = await venueWithCourt("Link Arena"));
  });
  const book = async (hour: number, days = 3) => {
    const p = phone();
    const made = await createBooking({ courtId, date: addDays(todayISO(), days), hours: [hour], name: "Kumar Selvam", phone: p, email: "kumar@link.test" });
    if (!made.ok) throw new Error(made.error);
    return made.booking;
  };

  it("is signed, for that booking only, runs out, and never carries the phone", async () => {
    const b = await book(9);
    const token = bookingLinkToken(b.code, b.date);
    expect(checkBookingLink(b.code, token)).toBe("ok");
    expect(checkBookingLink(b.code.toLowerCase(), token)).toBe("ok");
    expect(checkBookingLink("MS-OTHER1", token)).toBe("invalid");
    expect(checkBookingLink(b.code, token.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBe("invalid");
    expect(checkBookingLink(b.code, "nonsense")).toBe("invalid");
    // A stamp moved later is not signed for.
    const [, sig] = token.split(".");
    expect(checkBookingLink(b.code, `${(linkExpiry(b.date) + 86_400).toString(36)}.${sig}`)).toBe("invalid");
    // 30 days after the booking's day, and at least 14 from when it was made.
    expect(checkBookingLink(b.code, token, Date.parse(`${addDays(b.date, 29)}T12:00:00Z`))).toBe("ok");
    expect(checkBookingLink(b.code, token, Date.parse(`${addDays(b.date, 32)}T00:00:00Z`))).toBe("expired");
    const old = bookingLinkToken(b.code, "2020-01-01");
    expect(checkBookingLink(b.code, old, Date.now() + (LINK_MIN_DAYS - 1) * 86_400_000)).toBe("ok");
    const path = bookingLinkPath(b.code, b.date);
    expect(path).toMatch(new RegExp(`^/my-booking\\?code=${b.code}&t=[0-9a-z]+\\.[0-9a-f]{32}$`));
    expect(path).not.toContain(b.phone);
    expect(await phoneForLink(b.code, token)).toEqual({ phone: b.phone });
  });

  it("opens the booking without the phone typed, and a lookup hands back the link", async () => {
    const b = await book(10);
    const byPhone = await lookup(get(`http://localhost/api/bookings?code=${b.code}&phone=${b.phone}`));
    expect(byPhone.status).toBe(200);
    const found = await byPhone.json();
    expect(found.link).toMatch(/^\/my-booking\?code=/);
    const t = new URL(found.link, "http://x").searchParams.get("t")!;
    const byLink = await lookup(get(`http://localhost/api/bookings?code=${b.code}&t=${t}`));
    expect(byLink.status).toBe(200);
    expect((await byLink.json()).booking).toMatchObject({ code: b.code, phone: b.phone });

    // Another booking's link, or a made-up one, finds nothing; one run out says so.
    const other = await book(11);
    expect((await lookup(get(`http://localhost/api/bookings?code=${other.code}&t=${t}`))).status).toBe(404);
    const stale = bookingLinkToken(b.code, "2020-01-01", Date.parse("2020-01-01T00:00:00Z"));
    const expired = await lookup(get(`http://localhost/api/bookings?code=${b.code}&t=${stale}`));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: "Q8A_LINK_EXPIRED" });
    expect((await lookup(get(`http://localhost/api/bookings?code=${b.code}`))).status).toBe(400);
  });

  it("is what the confirmation sends, and opens the booking it names", async () => {
    const venue = (await listVenues())[0];
    const seeded = venue.courts.find((c) => c.capacity === 1)!.id;
    const made = await createBooking({ courtId: seeded, date: addDays(todayISO(), 6), hours: [14], name: "Siti", phone: phone(), email: "siti@link.test" });
    if (!made.ok) throw new Error(made.error);
    await notifyBookingConfirmed([made.booking], "en", null);
    const { messagesForBooking } = await import("../src/lib/outbox");
    const body = (await messagesForBooking(made.booking.id)).find((m) => m.kind === "booking_confirmed")!.body;
    const link = /https:\/\/\S+(\/my-booking\?code=([A-Z0-9-]+)&t=([0-9a-z.]+[0-9a-f]))/.exec(body);
    expect(link).not.toBeNull();
    expect(link![2]).toBe(made.booking.code);
    expect(body).not.toContain(`phone=`);
    const opened = await lookup(get(`http://localhost/api/bookings?code=${link![2]}&t=${link![3]}`));
    expect((await opened.json()).booking.id).toBe(made.booking.id);
  });
});

describe("a waiting-list offer at a venue that holds unpaid bookings (X2-2)", () => {
  let venueId: number;
  let courtId: number;
  // One live offer a court and day: each test its own day.
  let day = 3;
  let date = addDays(todayISO(), day);
  beforeAll(async () => {
    ({ venueId, courtId } = await venueWithCourt("Hold Hall", true));
    expect(await setHoldPolicy(venueId, { on: true, minutes: 15 })).toMatchObject({ ok: true });
  });

  async function offered(hour: number) {
    date = addDays(todayISO(), ++day);
    const holder = await createBooking({ courtId, date, hours: [hour], name: "Holder", phone: phone() });
    if (!holder.ok) throw new Error(holder.error);
    const waiter = phone();
    expect((await joinSlotWaitlist({ courtId, date, startHour: hour, endHour: hour + 1, name: "Bala", phone: waiter, email: "bala@wl.test" })).ok).toBe(true);
    expect((await cancelBooking(holder.booking.code, holder.booking.phone)).ok).toBe(true);
    const entry = (await listWaitlistFor(waiter))[0];
    expect(entry.status).toBe("offered");
    return { token: entry.offerToken!, waiter };
  }

  it("says what is offered before it is claimed, and that it will be held until paid", async () => {
    const { token } = await offered(9);
    const res = await offerRoute(get(`http://localhost/api/waitlist/claim?token=${token}`));
    expect(res.status).toBe(200);
    const { offer } = await res.json();
    expect(offer).toMatchObject({
      venue: { id: venueId, name: "Hold Hall" },
      kind: "court",
      what: "Court 1",
      date,
      startMin: 540,
      endMin: 600,
      price: 20,
      holdMinutes: 15,
      payOnline: true,
    });
    expect(offer.offerEnds).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Reading it changes nothing: it is still an offer.
    expect((await describeOffer(token)).ok).toBe(true);
  });

  it("claimed, it is held, with the way to pay by its own link", async () => {
    const { token, waiter } = await offered(10);
    const res = await claimRoute(postJson("http://localhost/api/waitlist/claim", { token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.holdUntil).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(body).toMatchObject({ payOnline: true, court: { name: "Court 1" }, venue: { id: venueId } });
    expect(checkBookingLink(body.booking.code, body.link)).toBe("ok");
    fakeBillplz();
    const paying = await pay(postJson("http://localhost/api/payments", { codes: [body.booking.code], t: body.link }));
    expect(paying.status).toBe(200);
    expect((await paying.json()).url).toMatch(/^https:\/\/www\.billplz-sandbox\.com\/bills\//);
    // The link pays only its own booking's number: another's code with it is refused.
    const stranger = await createBooking({ courtId, date, hours: [15], name: "Other", phone: phone() });
    if (!stranger.ok) throw new Error(stranger.error);
    const mixed = await pay(postJson("http://localhost/api/payments", { codes: [body.booking.code, stranger.booking.code], t: body.link }));
    expect(mixed.status).toBe(404);
    expect(waiter).toBe(body.booking.phone);
  });

  it("a gone offer is said so, and a made-up one is not found", async () => {
    const { token } = await offered(11);
    expect((await claimRoute(postJson("http://localhost/api/waitlist/claim", { token }))).status).toBe(200);
    const again = await offerRoute(get(`http://localhost/api/waitlist/claim?token=${token}`));
    expect(again.status).toBe(404);
    const made = await offerRoute(get(`http://localhost/api/waitlist/claim?token=${"f".repeat(32)}`));
    expect(made.status).toBe(404);
    expect(await made.json()).toMatchObject({ code: "OFFER_INVALID" });
    expect((await offerRoute(get("http://localhost/api/waitlist/claim"))).status).toBe(400);
  });

  it("at a venue that does not hold bookings, the offer says it is booked outright", async () => {
    const plain = await venueWithCourt("Open Court");
    const holder = await createBooking({ courtId: plain.courtId, date, hours: [9], name: "Holder", phone: phone() });
    if (!holder.ok) throw new Error(holder.error);
    const waiter = phone();
    await joinSlotWaitlist({ courtId: plain.courtId, date, startHour: 9, endHour: 10, name: "Wan", phone: waiter });
    await cancelBooking(holder.booking.code, holder.booking.phone);
    const token = (await listWaitlistFor(waiter))[0].offerToken!;
    const found = await describeOffer(token);
    expect(found).toMatchObject({ ok: true, offer: { holdMinutes: null, payOnline: false } });
  });
});

describe("the account's bookings (X2-4, X2-12)", () => {
  let venueId: number;
  let courtId: number;
  const date = addDays(todayISO(), 5);
  beforeAll(async () => {
    ({ venueId, courtId } = await venueWithCourt("Account Arena", true));
    expect(await setHoldPolicy(venueId, { on: true, minutes: 20, depositPercent: 50 })).toMatchObject({ ok: true });
  });
  const cookieFor = async (userId: number) => `${SESSION_COOKIE}=${(await createSession(userId)).token}`;

  it("a booking made as a guest shows once the account has proved the address, and is the account's to cancel", async () => {
    const guestPhone = phone();
    const made = await createBooking({ courtId, date, hours: [9], name: "Aisyah", phone: guestPhone, email: "Aisyah@Guest.test" });
    if (!made.ok) throw new Error(made.error);
    // An address only typed in shows nothing: a password account never proved it.
    const typed = await registerUser({ name: "Not Aisyah", email: "aisyah@guest.test", phone: phone(), password: "a long enough password" });
    if (!typed.ok) throw new Error(typed.error);
    expect((await listUserBookings(typed.user.id)).map((b) => b.code)).not.toContain(made.booking.code);
    expect(await accountHasBooking(typed.user.id, made.booking.id)).toBe(false);
    expect(await cancelUserBooking(typed.user.id, made.booking.id)).toMatchObject({ ok: false, code: "BOOKING_NOT_FOUND" });

    // Proved (by Google here; a sign-up or reset link does the same): it shows, and nothing about it moves.
    const proved = await signInWithIdentity({ provider: "google", subject: "g-q8a-1", email: "aisyah@guest.test", emailVerified: true, name: "Aisyah" });
    expect(proved).toMatchObject({ ok: true, userId: typed.user.id });
    const mine = await listUserBookings(typed.user.id);
    expect(mine.map((b) => b.code)).toContain(made.booking.code);
    expect(((await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(made.booking.id)) as { user_id: number | null }).user_id).toBeNull();
    // Another address's guest booking stays out.
    const other = await createBooking({ courtId, date, hours: [10], name: "Someone", phone: phone(), email: "someone@else.test" });
    if (!other.ok) throw new Error(other.error);
    expect((await listUserBookings(typed.user.id)).map((b) => b.code)).not.toContain(other.booking.code);
    expect(await accountHasBooking(typed.user.id, other.booking.id)).toBe(false);

    const cookie = await cookieFor(typed.user.id);
    const res = await myCancel(postJson("http://localhost/api/my/bookings/cancel", { bookingId: made.booking.id }, cookie));
    expect(res.status).toBe(200);
    expect((await res.json()).booking.status).toBe("cancelled");
    const refused = await myCancel(postJson("http://localhost/api/my/bookings/cancel", { bookingId: other.booking.id }, cookie));
    expect(await refused.json()).toMatchObject({ code: "BOOKING_NOT_FOUND" });
    expect(((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(other.booking.id)) as { status: string }).status).toBe("confirmed");
  });

  it("says a held booking is held, with what My Booking offers for it", async () => {
    const made = await registerUser({ name: "Hana", email: `hana${n}@acct.test`, phone: phone(), password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const booked = await createBooking({ courtId, date, hours: [12], name: "Hana", phone: made.user.phone, userId: made.user.id });
    if (!booked.ok) throw new Error(booked.error);
    const { holdNewBookings } = await import("../src/lib/holds");
    const until = await holdNewBookings([booked.booking.id], 20);
    const res = await myBookings(get("http://localhost/api/my/bookings", await cookieFor(made.user.id)));
    const { bookings } = await res.json();
    const row = bookings.find((b: { code: string }) => b.code === booked.booking.code);
    expect(row).toMatchObject({ holdUntil: until, paymentStatus: "unpaid", payOnline: true, depositPercent: 50, venueId });
    expect(row.lastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("a promo code checked before booking (X2-5)", () => {
  let venueId: number;
  let courtId: number;
  let adminId: number;
  const date = addDays(todayISO(), 6);
  beforeAll(async () => {
    ({ venueId, courtId } = await venueWithCourt("Promo Place"));
    await ensureBootstrapAdmin();
    adminId = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;
    const made = await createPromoCode({ venueId, code: "TENOFF", description: "Ten off", kind: "percent", value: 10, validFrom: todayISO(), validTo: addDays(todayISO(), 30), adminId });
    if (!made.ok) throw new Error(made.error);
    const later = await createPromoCode({ venueId, code: "LATER", description: "Next month", kind: "amount", value: 5, validFrom: addDays(todayISO(), 20), validTo: addDays(todayISO(), 40), adminId });
    if (!later.ok) throw new Error(later.error);
  });
  const ask = async (code: string) =>
    (await (await quote(get(`http://localhost/api/quote?courtId=${courtId}&date=${date}&start=540&end=600&promoCode=${encodeURIComponent(code)}`))).json()) as {
      total: number;
      promo?: { ok: boolean; discount?: number; error?: string; kind?: string; value?: number };
    };

  it("says what a good code takes off, the same as booking with it then takes", async () => {
    const q = await ask("tenoff");
    expect(q.total).toBe(20);
    expect(q.promo).toMatchObject({ ok: true, code: "TENOFF", kind: "percent", value: 10, discount: 2 });
    const { applyAskedDiscounts } = await import("../src/lib/booking-discounts");
    const made = await createBooking({ courtId, date, start: 540, end: 600, name: "Ravi", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    const applied = await applyAskedDiscounts([made.booking], { promoCode: "TENOFF" });
    expect(applied.discount).toBe(q.promo!.discount);
    expect(made.booking.totalPrice).toBe(q.total - q.promo!.discount!);
  });

  it("says why a code will not go on, before anything is booked", async () => {
    expect((await ask("WRONGCODE")).promo).toEqual({ ok: false, error: "That code is not valid at this venue." });
    expect((await ask("LATER")).promo).toMatchObject({ ok: false, error: expect.stringContaining("This code starts on") });
    expect((await (await quote(get(`http://localhost/api/quote?courtId=${courtId}&date=${date}&start=540&end=600`))).json()).promo).toBeUndefined();
  });
});

describe("giving a court back past the cutoff (X2-11)", () => {
  let venueId: number;
  let courtId: number;
  const date = addDays(todayISO(), 1);
  beforeAll(async () => {
    ({ venueId, courtId } = await venueWithCourt("Late Hall"));
    // Every booking tomorrow is inside the venue's three days.
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 72 WHERE id = ?").run(venueId);
  });
  const book = async (hour: number) => {
    const made = await createBooking({ courtId, date, hours: [hour], name: "Late Larry", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    return made.booking;
  };

  it("is off by default: past the cutoff the customer calls, as before", async () => {
    expect((await cancelPolicy(venueId)).giveBack).toBe(false);
    const b = await book(20);
    expect(await cancelBooking(b.code, b.phone)).toMatchObject({ ok: false });
    expect((await bookingTerms(venueId))!.giveBack).toBeUndefined();
  });

  it("turned on, the court goes back, nothing is refunded, and the next person waiting is offered it", async () => {
    expect(await setCancelPolicy(venueId, { giveBack: true })).toMatchObject({ ok: true, policy: { giveBack: true, lateKeep: null } });
    expect((await bookingTerms(venueId))!.giveBack).toBe(true);
    const b = await book(19);
    expect((await setPaymentStatus(b.code, true, "cash")).ok).toBe(true);
    const waiter = phone();
    await joinSlotWaitlist({ courtId, date, startHour: 19, endHour: 20, name: "Next", phone: waiter });
    const done = await cancelBooking(b.code, b.phone);
    expect(done).toMatchObject({ ok: true, kept: 20, booking: { status: "cancelled" } });
    const row = (await getDb().prepare("SELECT late_cancelled, late_kept_percent FROM bookings WHERE id = ?").get(b.id)) as {
      late_cancelled: number;
      late_kept_percent: number;
    };
    expect(row).toMatchObject({ late_cancelled: 1, late_kept_percent: 100 });
    // No credit note or credit: the venue keeps all of it.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM wallet_entries WHERE booking_id = ?").get(b.id)) as { n: number }).n).toBe(0);
    expect((await listWaitlistFor(waiter))[0].status).toBe("offered");
  });

  it("an unpaid court given back late is a strike where the venue counts them", async () => {
    expect(await setCancelPolicy(venueId, { giveBack: true, strikeLimit: 3 })).toMatchObject({ ok: true });
    const b = await book(18);
    expect((await cancelBooking(b.code, b.phone)).ok).toBe(true);
    expect(await strikesFor(venueId, b.phone)).toBe(1);
  });

  it("a late-cancel share, where the venue has one, is what applies", async () => {
    expect(await setCancelPolicy(venueId, { lateKeep: 50, giveBack: true })).toMatchObject({ ok: true });
    expect((await bookingTerms(venueId))!.giveBack).toBeUndefined();
    const b = await book(17);
    expect((await setPaymentStatus(b.code, true, "cash")).ok).toBe(true);
    expect(await cancelBooking(b.code, b.phone)).toMatchObject({ ok: true, kept: 10 });
  });

  it("is a yes or a no, and left out stays as it is", async () => {
    expect(await setCancelPolicy(venueId, { giveBack: "yes" })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { lateKeep: null })).toMatchObject({ ok: true, policy: { giveBack: true } });
    expect(await setCancelPolicy(venueId, { lateKeep: null, giveBack: false })).toMatchObject({ ok: true, policy: { giveBack: false } });
  });
});

describe("a class enrolment paid online (X2-19)", () => {
  it("ends with the way to pay where the venue takes payment online", async () => {
    const { venueId, courtId } = await venueWithCourt("Class Studio", true, 10);
    const made = await createClassSessions({ courtId, name: "Yoga", instructor: "Mei", date: addDays(todayISO(), 3), startHour: 9, endHour: 10, capacity: 5, price: 25 });
    if (!made.ok) throw new Error(made.error);
    const p = phone();
    const res = await enrol(postJson("http://localhost/api/classes/enrol", { classId: made.classes[0].id, name: "Lee", phone: p }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.payOnline).toBe(true);
    expect(checkBookingLink(body.booking.code, body.link)).toBe("ok");
    fakeBillplz();
    const paying = await pay(postJson("http://localhost/api/payments", { codes: [body.booking.code], t: body.link }));
    expect(paying.status).toBe(200);
    expect(venueId).toBeGreaterThan(0);

    // Where it does not, nothing to pay online.
    const plain = await venueWithCourt("Plain Studio", false, 10);
    const other = await createClassSessions({ courtId: plain.courtId, name: "Pilates", instructor: "Ann", date: addDays(todayISO(), 3), startHour: 9, endHour: 10, capacity: 5, price: 25 });
    if (!other.ok) throw new Error(other.error);
    resetRateLimits();
    const plainRes = await enrol(postJson("http://localhost/api/classes/enrol", { classId: other.classes[0].id, name: "Lee", phone: phone() }));
    expect((await plainRes.json()).payOnline).toBe(false);
  });
});
