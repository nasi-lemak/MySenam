import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as bookingsPost, GET as bookingsGet } from "../src/app/api/bookings/route";
import { GET as quoteGet } from "../src/app/api/quote/route";
import { POST as checkInPost } from "../src/app/api/admin/check-in/route";
import { POST as gamesPost } from "../src/app/api/admin/bookings/games/route";
import { POST as mcpPost } from "../src/app/api/mcp/route";
import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { gameHold, gamesUpTo, soldByGame } from "../src/lib/booking-rules";
import { policyFor, updatePolicy, validateSettings } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { NO_PRICING_RULES, priceBooking } from "../src/lib/pricing";
import { bookThroughKey } from "../src/lib/key-bookings";
import { playbookFor } from "../src/lib/guide/playbook/server";
import { bookingSale } from "../src/lib/documents";
import { receiptLineText } from "../src/lib/receipts";
import { translator } from "../src/lib/i18n";
import { customerCourtName, laneHidden, laneWords } from "../src/lib/lanes";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createResources } from "../src/lib/resources";
import {
  addGames,
  cancelBooking,
  checkInOnLane,
  createBooking,
  createBookingOnAnyCourt,
  createVenue,
  findBookingByCode,
  getAvailability,
  joinSlotWaitlist,
  quoteFor,
  searchAvailability,
  setPaymentStatus,
  venueHours,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Court } from "../src/lib/types";

/**
 * Bowling sold by the game, with a lane given on arrival
 * (docs/features/booking.md#by-the-game-and-a-lane-given-on-arrival): the
 * catalogue gives bowling both as booking rules, so none of this branches on
 * the sport. A booking is games and players, held for the venue's estimate
 * and priced per game; it holds one lane under the claims like any booking,
 * but the customer is never told which before check-in, where the desk may
 * give them any lane free.
 */

let venueId: number;
let lanes: Court[];
let byTimeVenue: number;
let badminton: number;
let deskCookie: string;
const date = addDays(todayISO(), 3);
const TEN = 10 * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

const post = (url: string, body: unknown, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${n % 250}`, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const get = (url: string) => new NextRequest(`http://localhost${url}`, { headers: { "x-forwarded-for": `203.0.113.${n % 250}` } });

/** The venue's own minute of the day now, and the next start on its half hours a little ahead (check-in is open by then). */
function nextStart(zone: string): number {
  const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
  return Math.ceil((h * 60 + m + 1) / 30) * 30;
}

beforeAll(async () => {
  const v = await createVenue({ name: "Strike Alley", area: "Subang", address: "1 Jalan Pin", phone: "0312345678", openMin: 0, closeMin: 24 * 60 });
  if (!v.ok) throw new Error(v.error);
  venueId = v.venue.id;
  const made = await createResources({ venueId, sport: "bowling", count: 3, offPeakRate: 30, peakRate: 30, capacity: 1, perPlayer: true, maxPlayers: 6 });
  if (!made.ok) throw new Error(made.error);
  lanes = made.courts;
  // The venue's price for a game, per player: the rest is the catalogue's (12 minutes a game, 10 more a player, 6 games at most).
  expect((await updatePolicy({ venue: venueId, sport: "bowling" }, { gamePrice: 12 })).ok).toBe(true);

  const other = await createVenue({ name: "Time Lanes", area: "Subang", address: "2 Jalan Pin", phone: "0312345679", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!other.ok) throw new Error(other.error);
  byTimeVenue = other.venue.id;
  const court = await createResources({ venueId: byTimeVenue, sport: "badminton", count: 1, offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error(court.error);
  badminton = court.courts[0].id;

  const d = await createAdmin({ name: "Dina Desk", email: "desk@bowl.test", password: "a long enough password", venueId, role: "desk" });
  if (!d.ok) throw new Error("admin");
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
});

afterEach(async () => {
  await resetRateLimits();
});

describe("the catalogue and the rules", () => {
  it("gives bowling, as data, sold by the game with a lane given on arrival, and supports it fully", async () => {
    const bowling = BUILTIN_ACTIVITIES.find((a) => a.key === "bowling")!;
    expect(bowling.support).toBe("full");
    expect(bowling.supportNote).toBeNull();
    expect(bowling.policy).toMatchObject({ gameMinutes: 12, gameMinutesEach: 10, maxGames: 6, laneOnArrival: true });
    const policy = await policyFor({ id: lanes[0].id, venueId, sport: "bowling" });
    expect(soldByGame(policy)).toBe(true);
    expect(policy.laneOnArrival).toBe(true);
    expect(policy.pricing).toMatchObject({ gamePrice: 12, gamePeakPrice: null });
    // Not every lane activity: table tennis tables are sold by time.
    expect(soldByGame(await policyFor({ id: badminton, venueId: byTimeVenue, sport: "badminton" }))).toBe(false);
  });

  it("prices a game at peak by its start, a tier's share and a last-minute price as a fixed price is", () => {
    const court = { sport: "bowling", offPeakRate: 30, peakRate: 30, memberOffPeakRate: null, memberPeakRate: null, perPlayer: true, rateChanges: [], capacity: 1, flatRate: false, quantityPrices: null };
    const pricing = { ...NO_PRICING_RULES, gamePrice: 12, gamePeakPrice: 15 };
    // Saturday 7 November 2026 is peak all day; Monday 9 November at 10:00 is not.
    const at = (date: string, member: number | boolean = false) =>
      priceBooking({ court, date, span: { start: TEN, end: TEN + 60 }, pricing, games: 2, players: 2, member }).total;
    expect(at("2026-11-09")).toBe(48);
    expect(at("2026-11-07")).toBe(60);
    expect(at("2026-11-09", 50)).toBe(24);
    // Without games, the same court is priced by the minute.
    expect(priceBooking({ court, date: "2026-11-09", span: { start: TEN, end: TEN + 60 }, pricing, players: 2 }).total).toBe(60);
  });

  it("holds the games for the estimate, players counted, rounded up to the length step", () => {
    const p = { gameMinutes: 12, gameMinutesEach: 10, lengthStep: 15, maxGames: 6 };
    expect(gameHold(p, 1, 1)).toBe(15); // 12
    expect(gameHold(p, 2, 3)).toBe(75); // 2 × 32 = 64
    expect(gameHold(p, 1, 6)).toBe(75); // 62
    expect(gamesUpTo(p, 4, 120)).toEqual([1, 2]); // 42 and 84 fit; 126 does not
    expect(gamesUpTo(p, 1)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("checks the settings a venue gives: 0 sells by time again, games 1 to 20", async () => {
    expect(validateSettings({ gameMinutes: 0 })).toMatchObject({ ok: true, settings: { gameMinutes: 0 } });
    expect(validateSettings({ gameMinutes: 300 })).toMatchObject({ ok: false });
    expect(validateSettings({ maxGames: 21 })).toMatchObject({ ok: false });
    expect(validateSettings({ laneOnArrival: "yes" })).toMatchObject({ ok: false });
    expect(validateSettings({ gamePrice: -1 })).toMatchObject({ ok: false });
    // A venue that sells its lanes by time sets 0 over the catalogue's games.
    const v = await createVenue({ name: "Old Bowl", area: "Subang", address: "3 Jalan Pin", phone: "0312345670", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error(v.error);
    const lane = await createResources({ venueId: v.venue.id, sport: "bowling", count: 1, offPeakRate: 40, peakRate: 40, perPlayer: true, maxPlayers: 6 });
    if (!lane.ok) throw new Error(lane.error);
    expect((await updatePolicy({ venue: v.venue.id, sport: "bowling" }, { gameMinutes: 0, laneOnArrival: false })).ok).toBe(true);
    const policy = await policyFor({ id: lane.courts[0].id, venueId: v.venue.id, sport: "bowling" });
    expect(soldByGame(policy)).toBe(false);
    expect(policy.laneOnArrival).toBe(false);
    const byTime = await createBooking({ courtId: lane.courts[0].id, date, start: TEN, end: TEN + 60, name: "Old", phone: phone(), players: 2 });
    expect(byTime.ok ? [byTime.booking.games, byTime.booking.laneOnArrival, byTime.booking.totalPrice] : byTime.error).toEqual([undefined, undefined, 80]);
  });
});

describe("booking by the game", () => {
  it("prices per game per player, holds the estimate, and keeps the games on the booking", async () => {
    const made = await createBooking({ courtId: lanes[0].id, date, start: TEN, games: 2, players: 3, name: "Bowler", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking).toMatchObject({ games: 2, players: 3, startMin: TEN, endMin: TEN + 75, totalPrice: 72, laneOnArrival: true });
    // The quote says the same, before booking.
    const quoted = await quoteFor({ courtId: lanes[1].id, date, start: TEN, games: 2, players: 3 });
    expect(quoted.ok && quoted.quote.total).toBe(72);
    expect(quoted.ok && quoted.span).toEqual({ start: TEN, end: TEN + 75 });
    expect(quoted.ok && quoted.quote.lines[0]).toMatchObject({ kind: "games", games: 2, rate: 12 });
    await cancelBooking(made.booking.code, made.booking.phone);
  });

  it("refuses a time on a lane sold by the game, games on a court sold by time, and more games than the venue sells", async () => {
    expect(await createBooking({ courtId: lanes[0].id, date, start: TEN, end: TEN + 60, name: "Timer", phone: phone() })).toMatchObject({ ok: false, code: "GAMES_NEEDED" });
    expect(await createBooking({ courtId: lanes[0].id, date, start: TEN, games: 7, players: 1, name: "Greedy", phone: phone() })).toMatchObject({ ok: false, code: "GAMES_RANGE", vars: { max: 6 } });
    expect(await createBooking({ courtId: badminton, date, start: TEN, games: 1, name: "Shuttle", phone: phone() })).toMatchObject({ ok: false, code: "GAMES_NOT_HERE" });
    expect(await quoteFor({ courtId: lanes[0].id, date, start: TEN, end: TEN + 60 })).toMatchObject({ ok: false, code: "GAMES_NEEDED" });
    // No waiting list for a time on a lane sold by the game: its offer would be booked by time.
    expect(await joinSlotWaitlist({ courtId: lanes[0].id, date, start: TEN, end: TEN + 30, name: "Waiter", phone: phone() })).toMatchObject({ ok: false, code: "GAMES_NO_WAITLIST" });
  });

  it("leaves a court sold by time as it was", async () => {
    const made = await createBooking({ courtId: badminton, date, start: TEN, end: TEN + 60, name: "Shuttle", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking).toMatchObject({ endMin: TEN + 60, totalPrice: 20 });
    expect(made.booking.games).toBeUndefined();
    expect(made.booking.laneOnArrival).toBeUndefined();
    const avail = await getAvailability(byTimeVenue, date, "badminton");
    expect(avail[0].policy.gameMinutes).toBeUndefined();
    expect(avail[0].policy.laneOnArrival).toBeUndefined();
  });

  it("without a price per game, costs the time it holds at the lane's rates", async () => {
    const v = await createVenue({ name: "Plain Bowl", area: "Subang", address: "4 Jalan Pin", phone: "0312345671", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error(v.error);
    const lane = await createResources({ venueId: v.venue.id, sport: "bowling", count: 1, offPeakRate: 30, peakRate: 30, perPlayer: true, maxPlayers: 6 });
    if (!lane.ok) throw new Error(lane.error);
    const made = await createBooking({ courtId: lane.courts[0].id, date, start: TEN, games: 1, players: 2, name: "Pair", phone: phone() });
    // 12 + 10 = 22 minutes, held for 30: half an hour at 30 an hour, for each of two.
    expect(made.ok ? [made.booking.endMin - made.booking.startMin, made.booking.totalPrice] : made.error).toEqual([30, 30]);
  });

  it("shows lanes free at each time, and books any lane, the next one when the first is taken", async () => {
    const day = addDays(date, 1);
    const freeAt = async (minute: number) => (await getAvailability(venueId, day, "bowling")).filter((a) => a.slots.find((s) => s.minute === minute)?.available).length;
    const avail = await getAvailability(venueId, day, "bowling");
    expect(avail.every((a) => a.policy.laneOnArrival === true && a.policy.gameMinutes === 12 && a.policy.maxGames === 6)).toBe(true);
    expect(await freeAt(TEN)).toBe(3);
    const first = await createBookingOnAnyCourt({ venueId, sport: "bowling", date: day, start: TEN, games: 1, players: 2, name: "Any", phone: phone() });
    const second = await createBookingOnAnyCourt({ venueId, sport: "bowling", date: day, start: TEN, games: 1, players: 2, name: "Any", phone: phone() });
    if (!first.ok || !second.ok) throw new Error("any lane");
    expect(first.bookings[0].courtId).not.toBe(second.bookings[0].courtId);
    expect(await freeAt(TEN)).toBe(1);
    // The board's starts go as far as the games for the most players, past the policy's longest length by time.
    const option = avail[0].starts.find((s) => s.minute === TEN)!;
    expect(option.maxLength).toBeGreaterThanOrEqual(gameHold({ gameMinutes: 12, gameMinutesEach: 10, lengthStep: 15 }, 2, 6));
    // Search finds a lane, one game for one player, without naming it.
    const found = await searchAvailability({ sport: "bowling", date: day, fromMin: TEN, toMin: TEN, minutes: 60, venueIds: [venueId] });
    expect(found[0]).toMatchObject({ games: 1, laneOnArrival: true, startMin: TEN, endMin: TEN + 15, totalPrice: 12 });
    expect(found.every((r) => r.games === 1)).toBe(true);
  });
});

describe("a lane given on arrival", () => {
  it("is never named to the customer before check-in: the booking's answer, its look-up and its messages", async () => {
    const who = { name: "Lena Lanes", phone: phone(), email: "lena@bowl.test" };
    const res = await bookingsPost(post("/api/bookings", { venueId, sport: "bowling", date, start: 14 * 60, games: 2, players: 2, ...who }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    const booking = body.booking;
    const lane = lanes.find((l) => l.id === booking.courtId)!;
    expect(booking).toMatchObject({ games: 2, laneOnArrival: true, totalPrice: 48 });
    expect(body.court.name).toBe(laneWords("en"));
    expect(JSON.stringify(body)).not.toContain(lane.name);
    const looked = await (await bookingsGet(get(`/api/bookings?code=${booking.code}&phone=${encodeURIComponent(who.phone)}`))).json();
    expect(looked.court.name).toBe(laneWords("en"));
    expect(JSON.stringify(looked)).not.toContain(lane.name);
    const sent = (await getDb().prepare("SELECT subject, body, calendar FROM messages WHERE booking_id = ?").all(booking.id)) as { subject: string; body: string; calendar: string | null }[];
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) expect(`${m.subject} ${m.body} ${m.calendar ?? ""}`).not.toContain(lane.name);
    expect(sent.some((m) => m.body.includes(laneWords("en")))).toBe(true);
    // Paid before it is checked in: the receipt says a lane is given on arrival, in the reader's language.
    expect((await setPaymentStatus(booking.code, true, "cash", "manager", null)).ok).toBe(true);
    const sale = (await bookingSale(booking.id))!;
    expect(JSON.stringify(sale.lines)).not.toContain(lane.name);
    expect(sale.lines[0].slot).toMatchObject({ onArrival: true, players: 2 });
    expect(receiptLineText(translator("ms"), sale.lines[0])).toContain(laneWords("ms"));
    // The helpers say the same, in each language, and nothing once checked in.
    expect(laneHidden({ laneOnArrival: true, checkedInAt: null })).toBe(true);
    expect(laneHidden({ laneOnArrival: true, checkedInAt: "2026-11-02 10:00:00" })).toBe(false);
    expect(customerCourtName("Lane 2", { laneOnArrival: true, checkedInAt: null }, "ms")).toBe(laneWords("ms"));
    expect(customerCourtName("Court 1", { checkedInAt: null }, "en")).toBe("Court 1");
  });

  it("is given at check-in: any lane free for its time, refused (and not checked in) where it is not; then it is shown", async () => {
    const { zone } = await venueHours(venueId);
    const today = todayISO(zone);
    const start = nextStart(zone);
    const who = { name: "Arriving", phone: phone() };
    const mine = await createBookingOnAnyCourt({ venueId, sport: "bowling", date: today, start, games: 1, players: 2, ...who });
    if (!mine.ok) throw new Error(mine.error);
    const held = mine.bookings[0];
    const [taken, free] = lanes.filter((l) => l.id !== held.courtId);
    const other = await createBooking({ courtId: taken.id, date: today, start, games: 1, players: 2, name: "Other", phone: phone() });
    if (!other.ok) throw new Error(other.error);

    // A lane already taken then: refused, nothing moved, not checked in.
    const refused = await checkInOnLane(held.code, taken.id);
    expect(refused.ok).toBe(false);
    expect((await findBookingByCode(held.code))).toMatchObject({ courtId: held.courtId, checkedInAt: null });

    // A free one, by the desk's route: moved and checked in, on the record as a move.
    const res = await checkInPost(post("/api/admin/check-in", { code: held.code, laneId: free.id }, deskCookie));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.booking).toMatchObject({ courtId: free.id });
    expect(body.booking.checkedInAt).toBeTruthy();
    expect((await listActivity([venueId], { bookingCode: held.code })).map((a) => a.action)).toContain("booking.moved");
    // Now it is theirs, and named.
    const looked = await (await bookingsGet(get(`/api/bookings?code=${held.code}&phone=${encodeURIComponent(who.phone)}`))).json();
    expect(looked.court.name).toBe(free.name);
    // Its own lane checks it in where it is.
    const stay = await checkInOnLane(other.booking.code, taken.id);
    expect(stay.ok && stay.booking.courtId).toBe(taken.id);
  });

  it("is in the desk's playbook where the venue's lanes are given on arrival, and not where none are", async () => {
    const lanesStep = async (venue: number) => JSON.stringify(await playbookFor(venue, "desk")).includes("gp.during.checkin.lanes");
    expect(await lanesStep(venueId)).toBe(true);
    expect(await lanesStep(byTimeVenue)).toBe(false);
  });

  it("two people after the last free lane at once: one has it, the other is told none is free", async () => {
    const day = addDays(date, 2);
    const at = 16 * 60;
    for (const lane of lanes.slice(1)) {
      const filled = await createBooking({ courtId: lane.id, date: day, start: at, games: 2, players: 2, name: "Filler", phone: phone() });
      if (!filled.ok) throw new Error(filled.error);
    }
    const race = await Promise.all(
      [0, 1].map(() => createBookingOnAnyCourt({ venueId, sport: "bowling", date: day, start: at, games: 1, players: 2, name: "Racer", phone: phone() }))
    );
    expect(race.filter((r) => r.ok)).toHaveLength(1);
    const lost = race.find((r) => !r.ok)!;
    expect(lost.ok).toBe(false);
    const held = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(lanes[0].id, day)) as { n: number };
    expect(held.n).toBe(1);
  });
});

describe("more games at the desk, and the rest unchanged", () => {
  it("holds the lane on while it is free after, priced per game, and is refused when it is not, or once paid", async () => {
    const day = addDays(date, 4);
    const made = await createBooking({ courtId: lanes[2].id, date: day, start: TEN, games: 1, players: 2, name: "Overrun", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking).toMatchObject({ endMin: TEN + 30, totalPrice: 24 });
    // Through the desk's route, logged.
    const res = await gamesPost(post("/api/admin/bookings/games", { code: made.booking.code, add: 1 }, deskCookie));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ added: 1, priceChange: 24, booking: { games: 2, endMin: TEN + 60, totalPrice: 48 } });
    expect((await listActivity([venueId], { bookingCode: made.booking.code })).map((a) => a.action)).toContain("booking.games_added");
    // The next half hour on that lane is booked: no more.
    const next = await createBooking({ courtId: lanes[2].id, date: day, start: TEN + 60, games: 1, players: 1, name: "Next", phone: phone() });
    if (!next.ok) throw new Error(next.error);
    expect(await addGames(made.booking.code, 1)).toMatchObject({ ok: false, code: "GAMES_ADD_TAKEN" });
    expect(await findBookingByCode(made.booking.code)).toMatchObject({ games: 2, endMin: TEN + 60, totalPrice: 48 });
    // Past the most games, or on a booking by time, or once paid: refused.
    expect(await addGames(next.booking.code, 6)).toMatchObject({ ok: false, code: "GAMES_RANGE" });
    const paid = await setPaymentStatus(made.booking.code, true, "cash", "manager", null);
    expect(paid.ok).toBe(true);
    expect(await addGames(made.booking.code, 1)).toMatchObject({ ok: false, code: "GAMES_ADD_SETTLED" });
    const timeBooking = await createBooking({ courtId: badminton, date: day, start: TEN, end: TEN + 60, name: "Shuttle", phone: phone() });
    if (!timeBooking.ok) throw new Error(timeBooking.error);
    expect(await addGames(timeBooking.booking.code, 1)).toMatchObject({ ok: false, code: "GAMES_NOT_HERE" });
  });

  it("cancels as any booking does, letting the lane go", async () => {
    const day = addDays(date, 5);
    const who = phone();
    const made = await createBooking({ courtId: lanes[0].id, date: day, start: TEN, games: 3, players: 1, name: "Canceller", phone: who });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking.totalPrice).toBe(36);
    expect(await cancelBooking(made.booking.code, who)).toMatchObject({ ok: true });
    const again = await createBooking({ courtId: lanes[0].id, date: day, start: TEN, games: 3, players: 1, name: "Next", phone: phone() });
    expect(again.ok).toBe(true);
  });

  it("takes games through the venue's API and its MCP create_booking", async () => {
    const key = await createApiKey(venueId, { name: "Front system", scope: "write" }, null);
    if (!key.ok) throw new Error(key.error);
    const day = addDays(date, 6);
    const caller = { keyId: key.record.id, venueId, scope: "write" as const };
    const preview = await (await bookThroughKey(caller, { courtId: lanes[1].id, date: day, start: "11:00", games: 2, players: 2, name: "Api Bowler", phone: phone() }, { preview: true })).json();
    expect(preview.preview).toMatchObject({ games: 2, startMin: 660, endMin: 660 + 45, totalPrice: 48 });
    const made = await bookThroughKey(caller, { courtId: lanes[1].id, date: day, start: "11:00", games: 2, players: 2, name: "Api Bowler", phone: phone() });
    const body = await made.json();
    expect(made.status, JSON.stringify(body)).toBe(201);
    expect(body.booking).toMatchObject({ games: 2, laneOnArrival: true, laneProvisional: true, endMin: 705 });
    const byTime = await bookThroughKey(caller, { courtId: lanes[1].id, date: day, start: "13:00", end: "14:00", name: "Api Timer", phone: phone() });
    expect(await byTime.json()).toMatchObject({ code: "GAMES_NEEDED" });

    const call = async (args: Record<string, unknown>) => {
      const res = await mcpPost(
        new NextRequest("http://localhost/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key.key}`, "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_booking", arguments: args } }),
        })
      );
      return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    };
    const list = await mcpPost(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key.key}`, "x-forwarded-for": "198.51.100.78" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    );
    const tools = ((await list.json()) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
    expect(tools.find((t) => t.name === "create_booking")!.inputSchema.properties.games).toBeDefined();
    const booked = await call({ courtId: lanes[1].id, date: day, start: "15:00", games: 1, players: 3, name: "Mcp Bowler", phone: phone(), confirm: true });
    expect(booked.isError, booked.content[0].text).toBeFalsy();
    expect(booked.content[0].text).toMatch(/^Booked: MS-/);
  });

  it("quotes games for any lane, as the board asks for them", async () => {
    const res = await quoteGet(get(`/api/quote?venueId=${venueId}&sport=bowling&date=${addDays(date, 7)}&start=600&games=3&players=2`));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ total: 72, allowed: true });
  });
});
