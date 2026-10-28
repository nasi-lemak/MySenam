import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { createAdmin } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { participantHistory } from "../src/lib/participants";
import { withdrawOptions } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { createBookingSeries, createVenue, getBookingById, getWalletBalance, topUpWallet } from "../src/lib/store";
import { setHouseRules } from "../src/lib/house-rules";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as apiWithdraw from "../src/app/api/v1/bookings/[code]/withdraw/route";

/**
 * Taking one person off a booking through the venue's API key
 * (`/api/v1/bookings/:code/withdraw`), as its counter does
 * (lib/place-withdrawals.ts): the same options and refusals, the counter's
 * terms and money, the customer told, the record and the activity log naming
 * the key; only the key's own venue's bookings; and a request sent again
 * under its `Idempotency-Key` taking nobody else off, on Postgres at the same
 * moment too.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;

let venue: number;
let pool: number;
let hall: number;
let managerId: number;
let readKey: string;
let writeKey: string;
let writeKeyId: number;
let otherKey: string;

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name: string) {
  const ph = `0176${String(++n).padStart(6, "0")}`;
  const made = await registerUser({ name: `${name} ${n}`, email: `aw${n}@aw.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}
const book = async (who: Adult, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, cookie: who.cookie },
      body: JSON.stringify({ name: who.name, phone: who.phone, email: `${who.email}`, ...body }),
    })
  );
  const out = (await res.json()) as { booking: { id: number; code: string; totalPrice: number; paymentStatus: string } };
  if (res.status !== 201) throw new Error(JSON.stringify(out));
  return out.booking;
};
const call = (code: string, key: string | null, init: { method?: string; body?: unknown; requestKey?: string } = {}) =>
  new NextRequest(`http://localhost/api/v1/bookings/${code}/withdraw`, {
    method: init.method ?? "GET",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.requestKey !== undefined ? { "idempotency-key": init.requestKey } : {}),
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.77",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const params = (code: string) => ({ params: Promise.resolve({ code }) });
const post = (code: string, key: string | null, body: unknown, requestKey?: string) =>
  apiWithdraw.POST(call(code, key, { method: "POST", body, requestKey }), params(code));
const placesHeld = async (bookingId: number) =>
  Number(((await getDb().prepare("SELECT COALESCE(SUM(places), 0) AS n FROM claims WHERE booking_id = ? AND active").get(bookingId)) as { n: number | string }).n);
const groupOf = async (who: Adult, date: string, players: number) => {
  const made = await createBookingSeries({ weeks: 1, name: who.name, phone: who.phone, userId: who.id, by: "staff", date, start: at(9), end: at(10), courtId: pool, players } as Parameters<typeof createBookingSeries>[0]);
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
};

beforeAll(async () => {
  const v = await createVenue({ name: "API Withdraw Centre", area: "Bangsar", address: "x", phone: "0312360801", openMin: at(7), closeMin: at(23) });
  const other = await createVenue({ name: "Elsewhere Centre", area: "Bangsar", address: "x", phone: "0312360802", openMin: at(7), closeMin: at(23) });
  if (!v.ok || !other.ok) throw new Error("venue");
  venue = v.venue.id;
  const p = await createResources({ venueId: venue, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 4, maxPlayers: 4 });
  const h = await createResources({ venueId: venue, sport: "badminton", name: "Hall", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!p.ok || !h.ok) throw new Error("resources");
  pool = p.courts[0].id;
  hall = h.courts[0].id;
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  const made = await createAdmin({ name: "Mira", email: "aw-mgr@aw.test", password: "a long enough password", venueId: venue, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  managerId = made.admin.id;
  const r = await createApiKey(venue, { name: "Desk screen", scope: "read" }, null);
  const w = await createApiKey(venue, { name: "Booking system", scope: "write" }, null);
  const o = await createApiKey(other.venue.id, { name: "Their system", scope: "write" }, null);
  if (!r.ok || !w.ok || !o.ok) throw new Error("keys");
  readKey = r.key;
  writeKey = w.key;
  writeKeyId = w.record.id;
  otherKey = o.key;
});

describe("taking one person off through the venue's API key", () => {
  it("offers what the counter offers, takes them off on the counter's terms, tells the guardian, and logs the key", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Aina"), await child(mum, "Badrul"), await child(mum, "Chen")];
    await topUpWallet({ userId: mum.id, amount: 100, adminId: managerId, venueId: venue });
    const before = await getWalletBalance(mum.id, venue);
    const b = await book(mum, { courtId: pool, date: day(3), start: at(9), end: at(10), participantIds: kids.map((k) => k.id), payFromWallet: true });
    expect(b.paymentStatus).toBe("paid");

    // The same people, the same answers, as staff at the counter see them.
    const res = await apiWithdraw.GET(call(b.code, readKey), params(b.code));
    expect(res.status).toBe(200);
    const { options } = (await res.json()) as { options: { name: string; allowed: boolean; refund: number; how: string; placeId: number }[] };
    const counter = await withdrawOptions((await getBookingById(b.id))!, { kind: "staff", adminId: managerId, name: "Mira" });
    expect(options).toEqual(JSON.parse(JSON.stringify(counter)));
    expect(options.map((o) => [o.name, o.allowed, o.refund, o.how])).toEqual([
      ["Aina", true, 10, "credit"],
      ["Badrul", true, 10, "credit"],
      ["Chen", true, 10, "credit"],
    ]);

    const done = await post(b.code, writeKey, { participantId: kids[1].id, reason: "Unwell" });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { booking: { code: string; players: number; participants: { name: string }[] }; withdrawal: { name: string; refund: number; how: string; released: number }; refunds: unknown[] };
    expect(body.withdrawal).toMatchObject({ name: "Badrul", refund: 10, how: "credit", released: 1 });
    expect(body.booking).toMatchObject({ code: b.code, players: 2 });
    expect(body.booking.participants.map((p) => p.name)).toEqual(["Aina", "Chen"]);
    expect(await getWalletBalance(mum.id, venue)).toBe(before - 20);
    expect(await placesHeld(b.id)).toBe(2);
    // On the record as the API's, by which key.
    const row = (await getDb().prepare("SELECT by_kind, by_api_key_id, by_name, by_admin_id, reason FROM place_withdrawals WHERE booking_id = ?").get(b.id)) as Record<string, unknown>;
    expect(row).toEqual({ by_kind: "api", by_api_key_id: writeKeyId, by_name: `API key ${writeKeyId}`, by_admin_id: null, reason: "Unwell" });
    const logged = (await listActivity([venue], { bookingCode: b.code })).filter((a) => a.action === "booking.place_withdrawn");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ adminId: null, adminName: `API key ${writeKeyId}` });
    expect(logged[0].detail).toContain("Badrul taken off");
    expect((await participantHistory(kids[1].id)).some((e) => e.action === "booking.withdrawn")).toBe(true);
    // The guardian is told, naming him.
    const msg = (await getDb().prepare("SELECT subject FROM messages WHERE booking_id = ? AND dedupe_key LIKE 'withdrawn:%'").get(b.id)) as { subject: string } | undefined;
    expect(msg?.subject).toContain("Badrul");
  });

  it("is refused as the counter refuses: a lesson, somebody not on it, the last person, and a body naming nobody", async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 20 * 60 }));
    const coach = await saveCoach(venue, { name: "Ana Lim", sports: ["badminton"], rate: 50, hours });
    if (!coach.ok) throw new Error(coach.error);
    const dad = await adult("Dad");
    const kid = await child(dad, "Dina");
    const lesson = await book(dad, { courtId: hall, date: day(4), start: at(10), end: at(11), coachId: coach.coach.id, participantIds: [kid.id], customerTakesPart: true });
    const refused = await post(lesson.code, writeKey, { participantId: kid.id });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "ENT_WITHDRAW_LESSON" });

    const two = await groupOf(dad, day(5), 2);
    expect(await (await post(two.code, writeKey, { participantId: 999999 })).json()).toMatchObject({ code: "ENT_WITHDRAW_NOT_ON" });
    expect(await (await post(two.code, writeKey, { unnamed: 2 })).json()).toMatchObject({ code: "ENT_WITHDRAW_NO_PLACES" });
    expect((await post(two.code, writeKey, { reason: "nobody" })).status).toBe(400);
    expect((await post("NOPE-0000", writeKey, { unnamed: 1 })).status).toBe(404);
    expect((await getBookingById(two.id))!.players).toBe(2);
  });

  it("reaches only the key's own venue: another venue's key sees and changes nothing, a read key cannot write, no key is refused", async () => {
    const dad = await adult("Dad");
    const g = await groupOf(dad, day(6), 3);
    expect((await apiWithdraw.GET(call(g.code, otherKey), params(g.code))).status).toBe(404);
    expect((await post(g.code, otherKey, { unnamed: 1 })).status).toBe(404);
    expect((await post(g.code, readKey, { unnamed: 1 })).status).toBe(403);
    expect((await post(g.code, null, { unnamed: 1 })).status).toBe(401);
    expect((await getBookingById(g.id))!.players).toBe(3);
    expect(await placesHeld(g.id)).toBe(3);
    expect(await getDb().prepare("SELECT 1 FROM place_withdrawals WHERE booking_id = ?").get(g.id)).toBeUndefined();
  });

  it("sent again under its Idempotency-Key, answers with what it did and takes nobody else off; the key used for another request is refused", async () => {
    const dad = await adult("Dad");
    const g = await groupOf(dad, day(7), 4);
    const first = await post(g.code, writeKey, { unnamed: 1 }, "req-7f3a");
    expect(first.status).toBe(200);
    const one = (await first.json()) as { withdrawal: { id: number; places: number; owedLess: number }; replayed?: boolean };
    expect(one.withdrawal).toMatchObject({ places: 1, owedLess: 10 });
    expect(one.replayed).toBeUndefined();
    const again = await post(g.code, writeKey, { unnamed: 1 }, "req-7f3a");
    expect(again.status).toBe(200);
    const two = (await again.json()) as { withdrawal: { id: number; places: number; owedLess: number }; replayed: boolean };
    expect(two).toMatchObject({ replayed: true, withdrawal: one.withdrawal });
    expect((await getBookingById(g.id))!).toMatchObject({ players: 3, totalPrice: 30 });
    expect(await placesHeld(g.id)).toBe(3);
    expect((await listActivity([venue], { bookingCode: g.code })).filter((a) => a.action === "booking.place_withdrawn")).toHaveLength(1);
    // The same key for a different request.
    expect((await post(g.code, writeKey, { unnamed: 2 }, "req-7f3a")).status).toBe(422);
    const other = await groupOf(dad, day(8), 2);
    expect((await post(other.code, writeKey, { unnamed: 1 }, "req-7f3a")).status).toBe(422);
    expect((await getBookingById(other.id))!.players).toBe(2);
    // A new key is a new withdrawal; without one, each request is its own.
    expect((await post(g.code, writeKey, { unnamed: 1 }, "req-7f3b")).status).toBe(200);
    expect((await getBookingById(g.id))!.players).toBe(2);
    // Keys are printable characters only.
    expect((await post(g.code, writeKey, { unnamed: 1 }, "has space")).status).toBe(400);
    expect((await getBookingById(g.id))!.players).toBe(2);
  });

  it("the same request sent several times at once takes one place off (real concurrency on Postgres)", async () => {
    const dad = await adult("Dad");
    const g = await groupOf(dad, day(9), 4);
    const results = await Promise.all(Array.from({ length: 4 }, () => post(g.code, writeKey, { unnamed: 1 }, "req-burst-1")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { withdrawal: { id: number }; replayed?: boolean }[];
    expect(new Set(bodies.map((b) => b.withdrawal.id)).size).toBe(1);
    expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
    expect((await getBookingById(g.id))!.players).toBe(3);
    expect(await placesHeld(g.id)).toBe(3);
  });
});
