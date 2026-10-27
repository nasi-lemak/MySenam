import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { planPassSpends, planTotals, type PlanPass } from "../src/lib/pass-rules";
import { withdrawPlace } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { setHouseRules } from "../src/lib/house-rules";
import { cancelBooking, createBookingSeries, createVenue, getPass, issuePass, payBookingWithPasses } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as counterRoute from "../src/app/api/admin/bookings/passes/route";

/**
 * Several passes for one booking (ADR 0025; lib/pass-rules.ts
 * `planPassSpends`): the booking form and the counter say which pass pays for
 * whom with the engine's own plan; one person's pass pays only that person's
 * place, every place covered or nothing spent; each spend names its place, so
 * a cancellation gives every spend back and one person taken off gives back
 * theirs; the last entries go to one booking however many race for them.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0176${String(++n).padStart(6, "0")}`;

let venue: number;
let pool: number;
let hall: number;
let desk: { id: number; name: string; cookie: string };

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `pa${n}@pa.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.66.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Booked = { id: number; code: string; totalPrice: number; paymentStatus: string };
const book = async (who: Adult, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { name: who.name, phone: who.phone, ...body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { booking: Booked } };
};

async function pass(holder: Adult, input: Partial<Parameters<typeof issuePass>[0]> = {}) {
  const made = await issuePass({
    venueId: venue,
    name: "Swim 10",
    entries: 10,
    entryMinutes: 60,
    price: 100,
    holderName: holder.name,
    holderPhone: holder.phone,
    userId: holder.id,
    expiresOn: day(60),
    adminId: desk.id,
    ...input,
  });
  if (!made.ok) throw new Error(made.error);
  return made.pass;
}

const spends = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT pass_id, delta, place_id, settles_entry_id FROM pass_entries WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { pass_id: number; delta: number; place_id: number | null; settles_entry_id: number | null }[];

beforeAll(async () => {
  const v = await createVenue({ name: "Pass Centre", area: "Wangsa Maju", address: "x", phone: "0312350951", openMin: at(7), closeMin: at(23) });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  const make = async (sport: string, name: string, capacity: number, rate: number) => {
    const r = await createResources({ venueId: venue, sport, name, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  pool = await make("swimming", "Pool", 8, 10);
  hall = await make("badminton", "Hall", 1, 20);
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  // The front desk: they take payments at the counter.
  const made = await createAdmin({ name: "Dina", email: `pa-desk${++n}@pa.test`, password: "a long enough password", venueId: venue, role: "desk" });
  if (!made.ok) throw new Error(made.error);
  desk = { id: made.admin.id, name: "Dina", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the plan", () => {
  const p = (id: number, over: Partial<PlanPass> = {}): PlanPass => ({
    id,
    code: `PS-${id}`,
    kind: "session",
    entryMinutes: 60,
    maxMinutes: null,
    holderName: "Mum",
    remaining: 3,
    scope: "participant",
    holderParticipantId: null,
    ...over,
  });
  const places = [
    { placeId: 11, customer: false, participantId: 1, name: "Aina" },
    { placeId: 12, customer: false, participantId: 2, name: "Badrul" },
  ];
  const base = { places, players: 2, minutes: 60, soldByPlace: true, bookerName: "Mum" };

  it("pays each place with its own person's pass, once each, and says what each spends", () => {
    const plan = planPassSpends({ ...base, passes: [p(1, { holderParticipantId: 2, holderParticipantName: "Badrul" }), p(2, { holderParticipantId: 1, holderParticipantName: "Aina" })] });
    expect(plan.ok && plan.spends.map((s) => [s.pass.id, s.placeId, s.units])).toEqual([
      [1, 12, 1],
      [2, 11, 1],
    ]);
    // Ninety minutes on a pass of hour entries: two each; one with one left is short.
    const long = planPassSpends({ ...base, minutes: 90, passes: [p(1, { holderParticipantId: 1 }), p(2, { holderParticipantId: 2, remaining: 1 })] });
    expect(long.ok && planTotals(long.spends).map((t) => [t.pass.id, t.units, t.enough])).toEqual([
      [1, 2, true],
      [2, 2, false],
    ]);
  });

  it("refuses with the engine's codes: a place left unpaid, a pass for somebody not on it, two for one place, a mix, places nobody is named on", () => {
    expect(planPassSpends({ ...base, passes: [p(1, { holderParticipantId: 1 })] })).toMatchObject({ ok: false, code: "ENT_PASS_UNCOVERED", vars: { names: "Badrul" } });
    expect(planPassSpends({ ...base, passes: [p(1, { holderParticipantId: 9, holderParticipantName: "Cik" })] })).toMatchObject({
      ok: false,
      code: "ENT_PASS_NOT_ON_BOOKING",
      vars: { name: "Cik" },
    });
    expect(planPassSpends({ ...base, passes: [p(1, { holderParticipantId: 1 }), p(2, { holderParticipantId: 1 })] })).toMatchObject({ ok: false, code: "ENT_PASS_TWICE", vars: { name: "Aina" } });
    expect(planPassSpends({ ...base, passes: [p(1, { scope: "booking" }), p(2, { holderParticipantId: 1 })] })).toMatchObject({ ok: false, code: "ENT_PASS_MIX" });
    expect(planPassSpends({ ...base, players: 3, passes: [p(1, { holderParticipantId: 1 })] })).toMatchObject({ ok: false, code: "ENT_PASS_UNNAMED" });
    expect(planPassSpends({ ...base, passes: [p(1, { scope: "resource" })] })).toMatchObject({ ok: false, code: "ENT_PASS_RESOURCE" });
    expect(planPassSpends({ ...base, passes: [p(1, { scope: "booking", maxMinutes: 60 })], minutes: 90 })).toMatchObject({ ok: false, code: "PASS_TOO_LONG", maxMinutes: 60 });
    // A pass spent per place: once for each place, named or not.
    const each = planPassSpends({ ...base, players: 3, passes: [p(1, { scope: "places" })] });
    expect(each.ok && each.spends.map((s) => s.placeId)).toEqual([11, 12, null]);
  });
});

describe("the booking form", () => {
  it("pays a booking for two children with each child's own pass, one spend a place; refused, nothing is spent", async () => {
    const mum = await adult("Mum");
    const [a, b] = [await child(mum, "Aina"), await child(mum, "Badrul")];
    const swimA = await pass(mum, { scope: "participant", holderParticipantId: a.id, name: "Aina's swim pass" });
    const swimB = await pass(mum, { scope: "participant", holderParticipantId: b.id, name: "Badrul's swim pass" });
    const made = await book(mum, { courtId: pool, date: day(3), start: at(9), end: at(10), participantIds: [a.id, b.id], payWithPasses: [swimA.code, swimB.code] });
    expect(made.status).toBe(201);
    expect(made.body.booking.paymentStatus).toBe("paid");
    const lines = await spends(made.body.booking.id);
    expect(lines.map((l) => [l.pass_id, l.delta])).toEqual([
      [swimA.id, -1],
      [swimB.id, -1],
    ]);
    expect(new Set(lines.map((l) => l.place_id)).size).toBe(2);

    // Aina's pass twice over (Badrul's place unpaid): it stands unpaid, saying whose place is left; nothing spent.
    const twice = await book(mum, { courtId: pool, date: day(3), start: at(11), end: at(12), participantIds: [a.id, b.id], payWithPasses: [swimA.code] });
    expect(twice.body.booking.paymentStatus).toBe("unpaid");
    expect(String(twice.body.walletError)).toContain("Badrul");
    expect((await getPass(swimA.code))!.remaining).toBe(9);
  });
});

describe("the counter", () => {
  it("sees the number's passes and the places, pays with the passes chosen, and refuses what does not cover the booking", async () => {
    const mum = await adult("Mum");
    const [a, b] = [await child(mum, "Cahaya"), await child(mum, "Dahlia")];
    const swimA = await pass(mum, { scope: "participant", holderParticipantId: a.id, name: "Cahaya's swim pass" });
    const swimB = await pass(mum, { scope: "participant", holderParticipantId: b.id, name: "Dahlia's swim pass", entries: 1 });
    const family = await pass(mum, { name: "Family 10" });
    // Another number's pass is not listed.
    const other = await adult("Other");
    await pass(other, { name: "Not theirs" });
    const made = await book(mum, { courtId: pool, date: day(4), start: at(9), end: at(10), participantIds: [a.id, b.id] });
    const code = made.body.booking.code;

    const seen = await counterRoute.GET(req(`http://localhost/api/admin/bookings/passes?code=${code}`, "GET", desk.cookie));
    expect(seen.status).toBe(200);
    const body = (await seen.json()) as { places: { name: string; participantId: number | null }[]; passes: { code: string; remaining: number }[]; soldByPlace: boolean; minutes: number };
    expect(body.places.map((p) => p.name)).toEqual(["Cahaya", "Dahlia"]);
    expect(body.passes.map((p) => p.code).sort()).toEqual([swimA.code, swimB.code, family.code].sort());
    expect(body).toMatchObject({ soldByPlace: true, minutes: 60 });

    // Cahaya's pass alone: refused, naming Dahlia; nothing spent.
    const short = await counterRoute.POST(req("http://localhost/api/admin/bookings/passes", "POST", desk.cookie, { code, passCodes: [swimA.code] }));
    expect(short.status).toBe(409);
    expect(await short.json()).toMatchObject({ code: "ENT_PASS_UNCOVERED", vars: { names: "Dahlia" } });
    // A whole-booking pass with a person's: not mixed.
    const mixed = await counterRoute.POST(req("http://localhost/api/admin/bookings/passes", "POST", desk.cookie, { code, passCodes: [family.code, swimB.code] }));
    expect(await mixed.json()).toMatchObject({ code: "ENT_PASS_MIX" });
    expect((await getPass(swimA.code))!.remaining).toBe(10);

    const paid = await counterRoute.POST(req("http://localhost/api/admin/bookings/passes", "POST", desk.cookie, { code, passCodes: [swimA.code, swimB.code] }));
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { booking: Booked }).booking).toMatchObject({ paymentStatus: "paid" });
    expect((await getPass(swimA.code))!.remaining).toBe(9);
    expect((await getPass(swimB.code))!.remaining).toBe(0);
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE booking_code = ? AND action = 'payment.paid'").get(code)) as { detail: string } | undefined;
    expect(logged?.detail).toContain("2 passes");
    // Paid already: asked again, refused.
    const again = await counterRoute.POST(req("http://localhost/api/admin/bookings/passes", "POST", desk.cookie, { code, passCodes: [swimA.code, swimB.code] }));
    expect(await again.json()).toMatchObject({ code: "ALREADY_PAID" });
    // Another venue's staff: not theirs to see.
    const outsider = await createAdmin({ name: "Out", email: `pa-out${++n}@pa.test`, password: "a long enough password", venueId: 1, role: "desk" });
    if (!outsider.ok) throw new Error(outsider.error);
    const outCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(outsider.admin.id)).token}`;
    expect((await counterRoute.GET(req(`http://localhost/api/admin/bookings/passes?code=${code}`, "GET", outCookie))).status).toBe(403);
  });
});

describe("given back", () => {
  it("cancelled, every place's spend comes back once; one child taken off, only that child's", async () => {
    const mum = await adult("Mum");
    const [a, b, c] = [await child(mum, "Ema"), await child(mum, "Fiza"), await child(mum, "Gina")];
    const passes = [
      await pass(mum, { scope: "participant", holderParticipantId: a.id, name: "Ema's" }),
      await pass(mum, { scope: "participant", holderParticipantId: b.id, name: "Fiza's" }),
      await pass(mum, { scope: "participant", holderParticipantId: c.id, name: "Gina's" }),
    ];
    const made = await book(mum, { courtId: pool, date: day(5), start: at(9), end: at(10), participantIds: [a.id, b.id, c.id], payWithPasses: passes.map((p) => p.code) });
    expect(made.body.booking.paymentStatus).toBe("paid");
    const off = await withdrawPlace(made.body.booking.id, { participantId: b.id }, { kind: "staff", adminId: desk.id, name: desk.name });
    expect(off.ok && off.withdrawal).toMatchObject({ units: 1, how: "pass" });
    expect((await Promise.all(passes.map((p) => getPass(p.code)))).map((p) => p!.remaining)).toEqual([9, 10, 9]);
    expect((await cancelBooking(made.body.booking.code, mum.phone)).ok).toBe(true);
    expect((await Promise.all(passes.map((p) => getPass(p.code)))).map((p) => p!.remaining)).toEqual([10, 10, 10]);
    // Each spend settled once: nothing minted.
    const lines = await spends(made.body.booking.id);
    expect(lines.filter((l) => l.delta > 0).every((l) => l.settles_entry_id !== null)).toBe(true);
    expect(lines.filter((l) => l.delta > 0)).toHaveLength(3);
  });
});

describe("racing", () => {
  it("two bookings for the last entry of a child's pass: one is paid, the other refused, the balance never below nothing", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Hana");
    const last = await pass(mum, { scope: "participant", holderParticipantId: a.id, name: "Hana's last", entries: 1 });
    const ids: number[] = [];
    for (const h of [9, 11, 13, 15]) {
      const made = await createBookingSeries({
        courtId: pool,
        date: day(6),
        start: at(h),
        end: at(h + 1),
        weeks: 1,
        name: mum.name,
        phone: mum.phone,
        userId: mum.id,
        participants: [{ id: a.id, name: a.name }],
        customerTakesPart: false,
      } as Parameters<typeof createBookingSeries>[0]);
      if (!made.ok) throw new Error(made.error);
      ids.push(made.bookings[0].id);
    }
    const results = await Promise.all(ids.map((id) => payBookingWithPasses(id, [last.code])));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await getPass(last.code))!.remaining).toBe(0);
    const total = (await getDb().prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM pass_entries WHERE pass_id = ?").get(last.id)) as { s: number | string };
    expect(Number(total.s)).toBe(-1);
  });

  it("a hall hired whole is paid by one pass for the booking, not by a person's", async () => {
    const dad = await adult("Dad");
    const whole = await pass(dad, { name: "Hall hours", scope: "resource", kind: "time", entries: 600, entryMinutes: null });
    const made = await book(dad, { courtId: hall, date: day(7), start: at(9), end: at(10), payWithPasses: [whole.code] });
    expect(made.body.booking.paymentStatus).toBe("paid");
    expect((await getPass(whole.code))!.remaining).toBe(540);
  });
});
