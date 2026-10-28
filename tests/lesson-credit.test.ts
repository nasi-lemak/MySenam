import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { cancelBooking, createCourt, createVenue, getBookingById, getWalletBalance, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * A one-to-one lesson paid from the account's stored credit, through the same
 * path a court takes (`payFromWallet` on `POST /api/bookings`, lib/store.ts
 * payBookingFromWallet): the court and the coach's fee taken from credit,
 * the booking paid, and given back in full on cancelling in time; too little
 * credit leaves the lesson booked and unpaid with the reason.
 */

let venueId: number;
let coach: Coach;
let managerId: number;
const date = addDays(todayISO(), 4);
let n = 0;

async function customer() {
  const made = await registerUser({ name: `Pupil ${++n}`, email: `lc${n}@lc.test`, phone: `0177100${String(n).padStart(3, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
const post = (who: { cookie: string; name: string; phone: string }, body: Record<string, unknown>) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}`, cookie: who.cookie },
      body: JSON.stringify({ venueId, sport: "tennis", date, name: who.name, phone: who.phone, ...body }),
    })
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Credit Coaching", area: "Bangsar", address: "1 Jalan Kredit", phone: "0322224444" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "tennis", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 20 * 60 }));
  const saved = await saveCoach(venueId, { name: "Ana Lim", sports: ["tennis"], rate: 80, hours });
  if (!saved.ok) throw new Error(saved.error);
  coach = saved.coach;
  const admin = await createAdmin({ name: "Mira", email: "lc-mgr@lc.test", password: "a long enough password", venueId, role: "manager" });
  if (!admin.ok) throw new Error(admin.error);
  managerId = admin.admin.id;
});

describe("a lesson paid from credit", () => {
  it("takes the court and the coach's fee from credit, and gives it all back on cancelling in time", async () => {
    const pupil = await customer();
    await topUpWallet({ userId: pupil.id, amount: 150, adminId: managerId, venueId });
    const before = await getWalletBalance(pupil.id, venueId);
    const res = await post(pupil, { hours: [10], coachId: coach.id, payFromWallet: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking: { id: number; code: string; totalPrice: number; paymentStatus: string; coachId: number }; walletError: string | null };
    expect(body.booking).toMatchObject({ totalPrice: 100, coachId: coach.id, paymentStatus: "paid" });
    expect(body.walletError).toBeNull();
    expect(await getWalletBalance(pupil.id, venueId)).toBe(before - 100);
    expect((await getBookingById(body.booking.id))!.paidVia).toBe("credit");
    const lines = (await getDb().prepare("SELECT amount::float AS amount FROM wallet_entries WHERE booking_id = ?").all(body.booking.id)) as { amount: number }[];
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(-100);
    expect((await cancelBooking(body.booking.code, pupil.phone)).ok).toBe(true);
    expect(await getWalletBalance(pupil.id, venueId)).toBe(before);
  });

  it("with too little credit, the lesson stands booked and unpaid, with the reason", async () => {
    const pupil = await customer();
    await topUpWallet({ userId: pupil.id, amount: 30, adminId: managerId, venueId });
    const res = await post(pupil, { hours: [12], coachId: coach.id, payFromWallet: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking: { paymentStatus: string }; walletError: string | null };
    expect(body.booking.paymentStatus).toBe("unpaid");
    expect(body.walletError).toBeTruthy();
    expect(await getWalletBalance(pupil.id, venueId)).toBe(30);
  });
});
