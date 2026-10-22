import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { setHoldPolicy } from "../src/lib/holds";
import { setHouseRules } from "../src/lib/house-rules";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createBooking, createCourt, createGroupBooking, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * Several courts at the same time, as one booking: a company night. Each
 * court its own booking and code; confirmed, held and paid together; all or
 * nothing.
 */

let venueId: number;
let otherVenueCourt: number;
const courts: number[] = [];
let n = 0;
const date = addDays(todayISO(), 3);
const phone = () => `0199990${String(++n).padStart(3, "0")}`;

const post = async (body: Record<string, unknown>) => {
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date, name: "Syarikat Maju", email: "hr@maju.my", ...body }),
    })
  );
  return { status: res.status, body: await res.json() };
};

const bookingCount = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n;

beforeAll(async () => {
  const made = await createVenue({ name: "Dewan Syarikat", area: "PJ", address: "x", phone: "0377770000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  for (const name of ["Court 1", "Court 2", "Court 3", "Court 4"]) {
    const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
  const other = await createVenue({ name: "Elsewhere", area: "KL", address: "y", phone: "0377770001" });
  if (!other.ok) throw new Error("venue");
  const c = await createCourt({ venueId: other.venue.id, name: "Far court", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error(c.error);
  otherVenueCourt = c.court.id;
});

afterEach(() => vi.unstubAllGlobals());

describe("booking several courts as one", () => {
  it("makes one booking per court, each with its own code, sharing a group code", async () => {
    const made = await createGroupBooking({ courtIds: [courts[0], courts[1], courts[2]], date, hours: [9, 10], name: "Team", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings.map((b) => b.courtId)).toEqual([courts[0], courts[1], courts[2]]);
    expect(new Set(made.bookings.map((b) => b.code)).size).toBe(3);
    expect(made.bookings[0].groupCode).toMatch(/^GR-/);
    expect(made.bookings.every((b) => b.groupCode === made.bookings[0].groupCode)).toBe(true);
    expect(made.seriesCode).toBeNull();
  });

  it("is all or nothing, saying which court could not be had", async () => {
    expect((await createBooking({ courtId: courts[2], date, hours: [12], name: "Before", phone: phone() })).ok).toBe(true);
    const before = await bookingCount();
    const refused = await createGroupBooking({ courtIds: [courts[0], courts[1], courts[2]], date, hours: [12], name: "Team", phone: phone() });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("Court 3");
    expect(await bookingCount()).toBe(before);
  });

  it("is 2 to 6 courts, at one venue", async () => {
    expect(await createGroupBooking({ courtIds: [courts[0]], date, hours: [14], name: "One", phone: phone() })).toMatchObject({ ok: false, code: "GROUP_COURTS" });
    expect(await createGroupBooking({ courtIds: [courts[0], otherVenueCourt], date, hours: [14], name: "Two places", phone: phone() })).toMatchObject({
      ok: false,
      code: "GROUP_ONE_VENUE",
    });
  });
});

describe("from the booking page", () => {
  it("books the courts together and confirms them in one message naming each code", async () => {
    const { status, body } = await post({ courtId: courts[0], moreCourts: [courts[1], courts[3]], hours: [15], phone: phone() });
    expect(status).toBe(201);
    expect(body.bookings).toHaveLength(3);
    expect(body.courtNames).toEqual({ [courts[0]]: "Court 1", [courts[1]]: "Court 2", [courts[3]]: "Court 4" });
    const messages = (await getDb()
      .prepare("SELECT kind, body FROM messages WHERE booking_id = ? AND channel = 'email'")
      .all(body.bookings[0].id)) as { kind: string; body: string }[];
    const confirmed = messages.filter((m) => m.kind === "booking_confirmed");
    expect(confirmed).toHaveLength(1);
    for (const b of body.bookings) expect(confirmed[0].body).toContain(b.code);
    expect(confirmed[0].body).toContain("Court 4");
  });

  it("is for one date without extras or a coach", async () => {
    const weekly = await post({ courtId: courts[0], moreCourts: [courts[1]], hours: [16], weeks: 2, phone: phone() });
    expect(weekly.body.code).toBe("GROUP_ONE_COURT_ONLY");
  });

  it("counts each court against the venue's limits", async () => {
    await setHouseRules(venueId, { perDay: 2 });
    const refused = await post({ courtId: courts[0], moreCourts: [courts[1], courts[2]], hours: [17], phone: phone() });
    expect(refused.status).not.toBe(201);
    expect((await post({ courtId: courts[0], moreCourts: [courts[1]], hours: [17], phone: phone() })).status).toBe(201);
    await setHouseRules(venueId, {});
  });

  it("held for payment, is paid in one bill and confirmed once", async () => {
    const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    await setHoldPolicy(venueId, { on: true, minutes: 15 });
    const who = phone();
    const { body } = await post({ courtId: courts[0], moreCourts: [courts[1]], hours: [19], phone: who });
    expect(body.holdUntil).not.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "groupbill1", url: "https://www.billplz-sandbox.com/bills/groupbill1" }))
    );
    const started = await startBookingPayment({ codes: body.bookings.map((b: { code: string }) => b.code), phone: who });
    expect(started).toMatchObject({ ok: true, amount: 40 });
    await settleBill({ billId: "groupbill1", paid: true, paidAt: null });
    for (const b of body.bookings) expect(await findBooking(b.code, who)).toMatchObject({ paymentStatus: "paid", holdUntil: null });
    const confirmed = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'booking_confirmed' AND channel = 'email' AND booking_id IN (?, ?)")
      .get(body.bookings[0].id, body.bookings[1].id)) as { n: number };
    expect(confirmed.n).toBe(1);
    await setHoldPolicy(venueId, { on: false });
  });
});
