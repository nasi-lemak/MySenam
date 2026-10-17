import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("../src/lib/transports", async (original) => ({
  ...(await original<typeof import("../src/lib/transports")>()),
  sendPlainEmail: async (to: string, subject: string, text: string) => {
    sent.push({ to, subject, text });
    return true;
  },
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startEntryPayment } from "../src/lib/payments";
import { createBooking, createVenue, getAvailability, joinSlotWaitlist, listVenues, listWaitlistFor } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import {
  cancelTournament,
  createTournament,
  enter,
  makeDraw,
  myEntry,
  publicTournaments,
  recordResult,
  setEntry,
  tournamentDetail,
  withdraw,
  type TournamentInput,
} from "../src/lib/tournaments";

/** Tournaments run by venues: courts held, entries, the draw, results, and who goes through. */

let venueId: number;
let courts: number[];
let ownerId: number;
let n = 0;
let dayOffset = 3;
const fixed = () => 0.42;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Player ${n}`, email: `t${n}@cup.my`, phone: `01340${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** A tournament on a day of its own, so no two tests hold the same hours. */
async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(todayISO(), dayOffset++);
  const made = await createTournament(
    {
      venueId,
      name: `Cup ${dayOffset}`,
      sport: "badminton",
      format: "knockout",
      teamSize: 1,
      level: null,
      entryFee: 20,
      maxEntries: 16,
      startsOn: day,
      endsOn: day,
      startHour: 9,
      endHour: 21,
      courtIds: courts,
      ...over,
    },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function entries(tournamentId: number, count: number) {
  const out: { user: User; entryId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await player();
    const made = await enter(user, tournamentId);
    if (!made.ok) throw new Error(made.error);
    out.push({ user, entryId: made.value.id });
  }
  return out;
}

/** Play every match that can be played now, the side named first winning. */
async function playOut(id: number) {
  for (let guard = 0; guard < 50; guard++) {
    const d = (await tournamentDetail(id))!;
    const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null && m.winner === null);
    if (!next) return d;
    const r = await recordResult(next.id, { winner: next.a!, score: "21-10, 21-12" });
    if (!r.ok) throw new Error(r.error);
  }
  throw new Error("never finished");
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

afterEach(() => vi.unstubAllGlobals());

describe("setting one up", () => {
  it("holds its courts, so nobody can book over it", async () => {
    const t = await tournament();
    const grid = await getAvailability(venueId, t.startsOn);
    const held = grid.filter((g) => courts.includes(g.court.id)).flatMap((g) => g.slots.filter((s) => s.hour >= 9 && s.hour < 21));
    expect(held.every((s) => !s.available)).toBe(true);
    const free = grid.filter((g) => courts.includes(g.court.id)).flatMap((g) => g.slots.filter((s) => s.hour >= 21));
    expect(free.some((s) => s.available)).toBe(true);
  });

  it("will not hold over a booking", async () => {
    const day = addDays(todayISO(), dayOffset++);
    expect((await createBooking({ courtId: courts[0], date: day, hours: [10], name: "Booked", phone: "0129990000" })).ok).toBe(true);
    const made = await createTournament(
      { venueId, name: "Clash Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 12, courtIds: courts },
      ownerId
    );
    expect(made).toMatchObject({ ok: false, clashes: 1 });
  });

  it("will not hold a court out of service, nor draw onto one taken out since", async () => {
    const day = addDays(todayISO(), dayOffset++);
    await getDb()
      .prepare("INSERT INTO court_outages (court_id, starts_on, ends_on, reason) VALUES (?, ?, ?, 'Resurfacing')")
      .run(courts[0], day, day);
    const base = { venueId, name: "Out Cup", sport: "badminton" as const, format: "knockout" as const, teamSize: 1 as const, level: null, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 10 };
    expect(await createTournament({ ...base, courtIds: courts }, ownerId)).toMatchObject({ ok: false, error: expect.stringContaining("out of service") });

    const t = await tournament({ startHour: 9, endHour: 12 });
    await entries(t.id, 4);
    await getDb()
      .prepare("INSERT INTO court_outages (court_id, starts_on, ends_on, reason) VALUES (?, ?, ?, 'Net torn')")
      .run(courts[1], t.startsOn, t.startsOn);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    expect(drawn.value.matches.filter((m) => m.status === "scheduled" && m.courtId !== null).every((m) => m.courtId === courts[0])).toBe(true);
  });

  it("checks what it is given", async () => {
    const base = { venueId, name: "Odd Cup", sport: "badminton" as const, format: "knockout" as const, teamSize: 1 as const, level: null, entryFee: 0, maxEntries: 8, startHour: 9, endHour: 12, courtIds: courts };
    const today = todayISO();
    expect(await createTournament({ ...base, startsOn: today, endsOn: today }, ownerId)).toMatchObject({ ok: false });
    expect(await createTournament({ ...base, startsOn: addDays(today, 40), endsOn: addDays(today, 60) }, ownerId)).toMatchObject({ ok: false });
    expect(await createTournament({ ...base, startsOn: addDays(today, 40), endsOn: addDays(today, 40), startHour: 5 }, ownerId)).toMatchObject({ ok: false });
    expect(await createTournament({ ...base, startsOn: addDays(today, 40), endsOn: addDays(today, 40), courtIds: [] }, ownerId)).toMatchObject({ ok: false });
  });
});

describe("entries", () => {
  it("fill up, then wait; a withdrawal lets the next one in", async () => {
    const t = await tournament({ maxEntries: 2 });
    const [a] = await entries(t.id, 2);
    const late = await player();
    sent.length = 0;
    const waiting = await enter(late, t.id);
    expect(waiting).toMatchObject({ ok: true, value: { status: "waitlisted" } });
    expect(sent[0].subject).toContain("waiting list");
    expect(await enter(late, t.id)).toMatchObject({ ok: false, error: "You have entered already." });

    await withdraw(a.entryId);
    expect((await myEntry(late.id, t.id))?.status).toBe("entered");
    expect(sent.at(-1)?.subject).toContain("You're in");
  });

  it("for doubles, name a partner", async () => {
    const t = await tournament({ teamSize: 2 });
    const p = await player();
    expect(await enter(p, t.id)).toMatchObject({ ok: false, error: "Name your partner." });
    expect(await enter(p, t.id, { partnerName: "Siti Aminah" })).toMatchObject({ ok: true, value: { name: `${p.name} / Siti Aminah` } });
  });
});

describe("a knockout", () => {
  it("gives the top seeds the byes, keeps them apart, and plays to a winner", async () => {
    const t = await tournament();
    const field = await entries(t.id, 5);
    await setEntry(field[4].entryId, { seed: 1 });
    await setEntry(field[3].entryId, { seed: 2 });
    sent.length = 0;
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    const d = drawn.value;
    const round1 = d.matches.filter((m) => m.round === 1);
    expect(round1).toHaveLength(4);
    expect(round1.filter((m) => m.status === "bye")).toHaveLength(3);
    // The two seeds have byes, on opposite halves.
    const byes = round1.filter((m) => m.status === "bye");
    expect(byes.map((m) => m.winner)).toEqual(expect.arrayContaining([field[4].entryId, field[3].entryId]));
    expect(round1[0].winner).toBe(field[4].entryId);
    // Everyone heard where to be.
    expect(sent.filter((m) => m.subject.startsWith("The draw is made"))).toHaveLength(5);

    // Every scheduled match has a court and an hour inside those held, nobody twice at once.
    const timed = d.matches.filter((m) => m.status === "scheduled");
    expect(timed.every((m) => m.courtId !== null && m.hour! >= 9 && m.hour! < 21)).toBe(true);

    const done = await playOut(t.id);
    expect(done.status).toBe("finished");
    const final = done.matches.find((m) => m.round === 3)!;
    expect(final.winner).not.toBeNull();
    // The hours it no longer needs, later than today, are back on sale.
    const left = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM slot_blocks WHERE tournament_id = ?").get(t.id)) as { n: number };
    expect(left.n).toBe(0);
  });

  it("says when the court time is too short", async () => {
    const t = await tournament({ startHour: 9, endHour: 10, courtIds: [courts[0]] });
    await entries(t.id, 4);
    expect(await makeDraw(t.id, fixed)).toMatchObject({ ok: false, error: expect.stringContaining("Not enough court time") });
  });

  it("takes results that agree with the winner, and can put one right until the next is played", async () => {
    const t = await tournament();
    const field = await entries(t.id, 4);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    const m = drawn.value.matches.find((x) => x.round === 1)!;
    expect(await recordResult(m.id, { winner: m.a!, score: "10-21, 12-21" })).toMatchObject({ ok: false, error: "That score says the other side won." });
    expect(await recordResult(m.id, { winner: m.a! })).toMatchObject({ ok: false });
    expect(await recordResult(m.id, { winner: field[0].entryId === m.a || field[0].entryId === m.b ? 999999 : field[0].entryId })).toMatchObject({ ok: false });
    expect((await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" })).ok).toBe(true);
    // Put right: the other side won.
    const fixedUp = await recordResult(m.id, { winner: m.b!, score: "10-21, 12-21" });
    if (!fixedUp.ok) throw new Error(fixedUp.error);
    const final = fixedUp.value.matches.find((x) => x.round === 2)!;
    expect([final.a, final.b]).toContain(m.b);
  });

  it("gives a walkover when somebody withdraws after the draw", async () => {
    const t = await tournament();
    const field = await entries(t.id, 2);
    await makeDraw(t.id, fixed);
    await withdraw(field[0].entryId);
    const d = (await tournamentDetail(t.id))!;
    expect(d.matches[0]).toMatchObject({ status: "walkover", winner: field[1].entryId });
    expect(d.status).toBe("finished");
  });
});

describe("groups, then a knockout", () => {
  it("plays every group, then puts group winners against the other group's runners-up", async () => {
    const t = await tournament({ format: "groups", groupSize: 3, advance: 2 });
    await entries(t.id, 6);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    expect(drawn.value.groups).toHaveLength(2);
    expect(drawn.value.matches.filter((m) => m.stage === "group")).toHaveLength(6);
    const semis = drawn.value.matches.filter((m) => m.stage === "knockout" && m.round === 1);
    expect(semis).toHaveLength(2);
    expect(semis.every((m) => m.a === null && m.b === null)).toBe(true);
    // The knockout comes after every group match.
    const lastGroup = drawn.value.matches.filter((m) => m.stage === "group").map((m) => `${m.date}:${String(m.hour).padStart(2, "0")}`).sort().at(-1)!;
    expect(semis.every((m) => `${m.date}:${String(m.hour).padStart(2, "0")}` > lastGroup)).toBe(true);

    // Play the groups.
    let d = (await tournamentDetail(t.id))!;
    for (const m of d.matches.filter((x) => x.stage === "group")) {
      const r = await recordResult(m.id, { winner: m.a!, score: "21-15, 21-15" });
      if (!r.ok) throw new Error(r.error);
    }
    d = (await tournamentDetail(t.id))!;
    const [g1, g2] = d.groups.map((g) => g.table.map((s) => s.entryId));
    const filled = d.matches.filter((m) => m.stage === "knockout" && m.round === 1).sort((a, b) => a.position - b.position);
    expect(filled.map((m) => [m.a, m.b])).toEqual([
      [g1[0], g2[1]],
      [g2[0], g1[1]],
    ]);
    expect((await playOut(t.id)).status).toBe("finished");
  });
});

describe("court time", () => {
  const heldHours = async (id: number) =>
    (
      (await getDb()
        .prepare("SELECT court_id, hour FROM slot_blocks WHERE tournament_id = ? ORDER BY court_id, hour")
        .all(id)) as { court_id: number; hour: number }[]
    ).map((b) => `${b.court_id}:${b.hour}`);

  it("is held whole until the draw, then only from each court's first match to its last", async () => {
    const t = await tournament();
    await entries(t.id, 4);
    expect(await heldHours(t.id)).toHaveLength(24);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    // Two semi-finals side by side at 9, the final at 10 on the first court.
    expect(await heldHours(t.id)).toEqual([`${courts[0]}:9`, `${courts[0]}:10`, `${courts[1]}:9`]);
    const grid = await getAvailability(venueId, t.startsOn);
    const at = (court: number, hour: number) => grid.find((g) => g.court.id === court)!.slots.find((x) => x.hour === hour)!.available;
    expect(at(courts[0], 10)).toBe(false);
    expect(at(courts[0], 11)).toBe(true);
    expect(at(courts[1], 10)).toBe(true);
  });

  it("keeps the hours between matches, gives back what a walkover leaves at the end, and everything once it is won", async () => {
    const t = await tournament({ courtIds: [courts[0]] });
    const field = await entries(t.id, 4);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    // One court: semi-finals at 9 and 10, the final at 11.
    expect(await heldHours(t.id)).toEqual([9, 10, 11].map((h) => `${courts[0]}:${h}`));
    const second = drawn.value.matches.find((m) => m.hour === 10)!;
    // Somebody in the 10 o'clock semi-final withdraws: that hour is between
    // two matches, so it stays held in case the first runs over.
    await withdraw(field.find((f) => f.entryId === second.a)!.entryId);
    expect(await heldHours(t.id)).toHaveLength(3);
    // The first semi-final is a walkover too: nothing before the final needs the court.
    const first = drawn.value.matches.find((m) => m.hour === 9)!;
    await withdraw(field.find((f) => f.entryId === first.a)!.entryId);
    expect(await heldHours(t.id)).toEqual([`${courts[0]}:11`]);
    expect((await playOut(t.id)).status).toBe("finished");
    expect(await heldHours(t.id)).toEqual([]);
  });

  it("offers what comes free to whoever is waiting for that court", async () => {
    // Tomorrow, within the days a waiting list takes; no other test uses it.
    const tomorrow = addDays(todayISO(), 1);
    const t = await tournament({ courtIds: [courts[1]], startsOn: tomorrow, endsOn: tomorrow });
    await entries(t.id, 2);
    const queued = await joinSlotWaitlist({ courtId: courts[1], date: t.startsOn, startHour: 18, endHour: 19, name: "Waiting Wong", phone: "0124445555" });
    expect(queued, JSON.stringify(queued)).toMatchObject({ ok: true });
    expect((await listWaitlistFor("0124445555"))[0].status).toBe("waiting");
    expect((await makeDraw(t.id, fixed)).ok).toBe(true);
    expect((await listWaitlistFor("0124445555"))[0].status).toBe("offered");
  });
});

describe("calling one off", () => {
  it("gives the courts back, tells everybody, and owes back fees paid online", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "entry-bill-1", url: "https://www.billplz-sandbox.com/bills/entry-bill-1" })));
    const t = await tournament();
    const [first] = await entries(t.id, 2);
    expect(await startEntryPayment(first.user, t.id)).toMatchObject({ ok: true, amount: 20 });
    await settleBill({ billId: "entry-bill-1", paid: true, paidAt: null });
    expect((await myEntry(first.user.id, t.id))?.paid).toBe(true);

    sent.length = 0;
    expect((await cancelTournament(t.id)).ok).toBe(true);
    expect(sent).toHaveLength(2);
    const held = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM slot_blocks WHERE tournament_id = ?").get(t.id)) as { n: number };
    expect(held.n).toBe(0);
    const owed = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = 'entry-bill-1'").get()) as { due: number };
    expect(owed.due).toBe(20);
    expect((await publicTournaments()).some((x) => x.id === t.id)).toBe(false);
  });
});

describe("a player closing their account", () => {
  it("is withdrawn from what is to come, and their name comes off the draw", async () => {
    const { eraseCustomer } = await import("../src/lib/privacy");
    const t = await tournament({ maxEntries: 2 });
    const [a] = await entries(t.id, 2);
    const waiting = await player();
    await enter(waiting, t.id);
    expect((await eraseCustomer(a.user.id)).ok).toBe(true);
    const d = (await tournamentDetail(t.id))!;
    expect(d.entries.some((e) => e.name === a.user.name)).toBe(false);
    expect((await myEntry(waiting.id, t.id))?.status).toBe("entered");
  });
});

describe("the routes", () => {
  it("are for the venue's own staff, and players need an account to enter", async () => {
    const t = await tournament();
    const other = await createVenue({ name: "Other Hall", area: "Klang", address: "9 Jalan Lain", phone: "0331112222" });
    if (!other.ok) throw new Error("venue");
    const desk = await createAdmin({ name: "Desk", email: "desk@otherhall.my", password: "desk-password", venueId: other.venue.id });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const staff = await import("../src/app/api/admin/tournaments/[id]/route");
    const res = await staff.POST(
      new NextRequest(`http://localhost/api/admin/tournaments/${t.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "draw" }),
      }),
      { params: Promise.resolve({ id: String(t.id) }) }
    );
    expect(res.status).toBe(403);

    const pub = await import("../src/app/api/tournaments/[id]/route");
    const asGuest = await pub.POST(
      new NextRequest(`http://localhost/api/tournaments/${t.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enter" }),
      }),
      { params: Promise.resolve({ id: String(t.id) }) }
    );
    expect(asGuest.status).toBe(401);
    const shown = await pub.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}`), { params: Promise.resolve({ id: String(t.id) }) });
    expect((await shown.json()).tournament.name).toBe(t.name);
  });
});
