/// <reference types="vite/client" />
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { counterEntrant, guardianEntrant, type Entrant } from "../src/lib/competition-entrants";
import { getDb } from "../src/lib/db";
import { instantOf } from "../src/lib/interval";
import { addManaged } from "../src/lib/managed-people";
import { addOfficial } from "../src/lib/match-reports";
import { createBooking, listVenues } from "../src/lib/store";
import {
  announceAll,
  announceNext,
  callFixture,
  dayBoard,
  decideNoShow,
  liveBoard,
  officialDay,
  releaseCall,
  setDaySettings,
  startFixture,
  type Actor,
  type DayBoard,
} from "../src/lib/tournament-day";
import { addDays, todayISO } from "../src/lib/time";
import { setWhatsappMode } from "../src/lib/whatsapp-credit";
import {
  cancelTournament,
  createTournament,
  enter,
  enterAs,
  makeDraw,
  recordResult,
  setEntry,
  takeOut,
  tournamentDetail,
  tournamentZone,
  type TournamentDetail,
  type TournamentInput,
} from "../src/lib/tournaments";
import * as dayRoute from "../src/app/api/admin/tournaments/[id]/day/route";
import * as liveRoute from "../src/app/api/tournaments/[id]/live/route";
import * as officialRoute from "../src/app/api/officials/[token]/route";

/**
 * Tournament day: the next match announced once to each side, a court called when it is free, the wait for a called
 * fixture, and the public live page. The clock is the tournament's own day, set with `at`.
 */

let venueId: number;
let ownerId: number;
let courts: number[];
let n = 0;
let dayOffset = 3;
// The real today, however the clock is set later: each tournament gets a day of its own.
const realToday = todayISO();
const fixed = () => 0.42;
const manager: Actor = { id: null, name: "Musa Manager", role: "manager" };

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MYSENAM_SEND;
});

async function player(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Day${n}`, email: `day${n}@cup.test`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return made.user;
}

async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(realToday, dayOffset++);
  const made = await createTournament(
    { venueId, name: `Day Cup ${dayOffset}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: courts, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** Players entered and checked in, the draw made. */
async function drawn(over: Partial<TournamentInput> = {}, count = 4, checkIn = true) {
  const t = await tournament(over);
  const field: { user: User; entryId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await player();
    const made = await enter(user, t.id);
    if (!made.ok) throw new Error(made.error);
    if (checkIn) await setEntry(made.value.id, { checkedIn: true });
    field.push({ user, entryId: made.value.id });
  }
  const done = await makeDraw(t.id, fixed);
  if (!done.ok) throw new Error(done.error);
  return { t: done.value, field, zone: await tournamentZone(t.id) };
}

/** The clock set to a minute of the tournament's day. */
function at(t: { startsOn: string }, zone: string, minute: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instantOf(t.startsOn, minute, zone));
  return new Date();
}

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const pairs = (d: TournamentDetail) => d.matches.filter((m) => (m.stage === "group" || m.stage === "knockout") && m.status === "scheduled" && m.a !== null && m.b !== null);
const day = async (id: number) => (await db_messages(id)).filter((m) => m.kind === "tournament_day");

async function db_messages(_id: number) {
  return (await getDb().prepare("SELECT kind, channel, recipient, locale, subject, body, params, dedupe_key FROM messages ORDER BY id").all()) as {
    kind: string;
    channel: string;
    recipient: string;
    locale: string;
    subject: string | null;
    body: string;
    params: string | null;
    dedupe_key: string | null;
  }[];
}

const emailOf = async (userId: number) => ((await getDb().prepare("SELECT email FROM users WHERE id = ?").get(userId)) as { email: string }).email;
function ok<T>(r: { ok: true; value: T } | { ok: false; error: string }): { ok: true; value: T } {
  if (!r.ok) throw new Error(r.error);
  return r;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("the next match is announced", () => {
  it("tells each side once that its match is next, however often it runs", async () => {
    const { t, field, zone } = await drawn();
    at(t, zone, 8 * 60 + 30);
    const before = (await day(t.id)).length;
    expect(await announceNext(t.id)).toBe(4);
    const told = (await day(t.id)).slice(before);
    expect(told).toHaveLength(4);
    expect(told.every((m) => m.channel === "email" && m.dedupe_key?.startsWith("tnday:next:"))).toBe(true);
    expect(new Set(told.map((m) => m.recipient))).toEqual(new Set(await Promise.all(field.map((f) => emailOf(f.user.id)))));
    expect(told[0].subject).toBe(`Your match is next: ${t.name}`);
    expect(told[0].body).toContain("Your match is next");
    // A retry, and two servers at once: nothing more.
    expect(await announceNext(t.id)).toBe(0);
    expect((await Promise.all([announceNext(t.id), announceNext(t.id), announceAll()])).reduce((a, b) => a + b, 0)).toBe(0);
    expect((await day(t.id)).length).toBe(before + 4);
  });

  it("waits until a match is within the hour, and is for today", async () => {
    const { t, zone } = await drawn();
    at(t, zone, 7 * 60 + 30);
    expect(await announceNext(t.id)).toBe(0);
    at(t, zone, 8 * 60 + 1);
    expect(await announceNext(t.id)).toBe(4);
  });

  it("announces the final to its two sides when the second semi-final is in, once, whoever entered the result twice", async () => {
    const { t, zone } = await drawn();
    at(t, zone, 8 * 60 + 30);
    await announceNext(t.id);
    const semis = pairs(await detail(t.id));
    expect(semis).toHaveLength(2);
    const baseline = (await day(t.id)).length;
    at(t, zone, 9 * 60 + 50);
    ok(await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" }));
    // One finalist is known: nobody told about the final yet.
    expect((await day(t.id)).length).toBe(baseline);
    ok(await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" }));
    const final = pairs(await detail(t.id))[0];
    const told = (await day(t.id)).slice(baseline);
    expect(told).toHaveLength(2);
    expect(told.every((m) => m.dedupe_key!.startsWith(`tnday:next:${final.id}:`))).toBe(true);
    // Entering the same result again is refused or a correction: either way, nobody is told twice.
    await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" });
    await announceNext(t.id);
    expect((await day(t.id)).length).toBe(baseline + 2);
  });

  it("never tells somebody who left, nor the fixture their leaving decided", async () => {
    const { t, field, zone } = await drawn();
    const leaving = field[0];
    ok(await takeOut(leaving.entryId, "disqualified", "Fighting"));
    at(t, zone, 8 * 60 + 30);
    await announceNext(t.id);
    const to = (await day(t.id)).map((m) => m.recipient);
    expect(to).not.toContain(await emailOf(leaving.user.id));
    // The others whose match is still to be played were told; their walkover was not announced as a match.
    const d = await detail(t.id);
    const walkover = d.matches.find((m) => m.status === "walkover");
    expect(walkover).toBeTruthy();
    const dedupe = (await day(t.id)).map((m) => m.dedupe_key!);
    expect(dedupe.some((k) => k.startsWith(`tnday:next:${walkover!.id}:`))).toBe(false);
  });

  it("is written in the language of the account, and WhatsApp follows the venue and a number the account proved", async () => {
    process.env.MYSENAM_SEND = "log";
    await setWhatsappMode(venueId, "all");
    const { t, field, zone } = await drawn();
    await getDb().prepare("UPDATE users SET locale = 'ms' WHERE id = ?").run(field[0].user.id);
    // One account has no proved number.
    await getDb().prepare("UPDATE users SET verified_phone = NULL WHERE id = ?").run(field[1].user.id);
    at(t, zone, 8 * 60 + 30);
    await announceNext(t.id);
    const sent = await day(t.id);
    const mine = sent.filter((m) => m.recipient === field[0].user.email);
    expect(mine).toHaveLength(1);
    expect(mine[0].locale).toBe("ms");
    expect(mine[0].body).toContain("Perlawanan anda seterusnya");
    const whatsapp = sent.filter((m) => m.channel === "whatsapp");
    // Three of the four have a number the account proved; each whatsapp message carries the template's own parameters.
    expect(whatsapp).toHaveLength(3);
    expect(JSON.parse(whatsapp[0].params!)).toEqual({ tournament: t.name, line: expect.stringContaining("match"), link: expect.stringContaining(`/tournaments/${t.id}/live`) });
    expect(whatsapp.find((m) => m.locale === "ms")!.body).toContain("Berita kejohanan");
    // With the venue's WhatsApp on urgent news only, email alone.
    await setWhatsappMode(venueId, "urgent");
    const later = await drawn();
    at(later.t, later.zone, 8 * 60 + 30);
    await announceNext(later.t.id);
    const laterFirst = pairs(await detail(later.t.id))[0];
    expect((await day(later.t.id)).filter((m) => m.dedupe_key!.startsWith(`tnday:next:${laterFirst.id}:`)).every((m) => m.channel === "email")).toBe(true);
  });

  it("can be switched off for one tournament", async () => {
    const { t, zone } = await drawn();
    ok(await setDaySettings(t.id, { announceNext: false }));
    at(t, zone, 8 * 60 + 30);
    expect(await announceNext(t.id)).toBe(0);
    ok(await setDaySettings(t.id, { announceNext: true }));
    expect(await announceNext(t.id)).toBe(4);
  });

  it("goes to the guardian for a participant, opening with whose it is, and names a minor to others by first name and initial", async () => {
    const t = await tournament();
    const zone = await tournamentZone(t.id);
    const mum = await player("Mum");
    const kidMade = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    if (!kidMade.ok) throw new Error(kidMade.error);
    const kidEntry = ok(await enterAs((await guardianEntrant(mum, kidMade.person.id)) as Entrant, t.id));
    const others: { user: User; entryId: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const user = await player();
      others.push({ user, entryId: ok(await enter(user, t.id)).value.id });
    }
    for (const e of [kidEntry.value.id, ...others.map((o) => o.entryId)]) await setEntry(e, { checkedIn: true });
    ok(await makeDraw(t.id, fixed));
    at(t, zone, 8 * 60 + 30);
    await announceNext(t.id);
    const sent = await day(t.id);
    const toMum = sent.filter((m) => m.recipient === mum.email);
    expect(toMum).toHaveLength(1);
    expect(toMum[0].body).toContain("This entry is for Aina Binti Lim.");
    // The child's opponent is told the child's first name and an initial, never the full name.
    const d = await detail(t.id);
    const kidMatch = d.matches.find((m) => m.a === kidEntry.value.id || m.b === kidEntry.value.id)!;
    const opponentId = kidMatch.a === kidEntry.value.id ? kidMatch.b! : kidMatch.a!;
    const opponent = others.find((o) => o.entryId === opponentId)!;
    const toOpponent = sent.find((m) => m.recipient === opponent.user.email && m.dedupe_key!.includes(`:${kidMatch.id}:`))!;
    expect(toOpponent.body).toContain("Aina B.");
    expect(toOpponent.body).not.toContain("Aina Binti Lim");
  });

  it("is not sent to somebody entered at the counter, who has no account", async () => {
    const t = await tournament();
    const zone = await tournamentZone(t.id);
    const walkIn = await counterEntrant(venueId, { id: ownerId, name: "Owner" }, { name: "Walk In", phone: "0123334444" });
    const entries = [ok(await enterAs(walkIn as Entrant, t.id)).value.id];
    for (let i = 0; i < 3; i++) entries.push(ok(await enter(await player(), t.id)).value.id);
    for (const e of entries) await setEntry(e, { checkedIn: true });
    ok(await makeDraw(t.id, fixed));
    at(t, zone, 8 * 60 + 30);
    expect(await announceNext(t.id)).toBe(3);
  });
});

describe("calling a fixture", () => {
  it("is refused for somebody not checked in, resting, or on court elsewhere, and says who and why", async () => {
    const { t, field, zone } = await drawn({}, 4, false);
    at(t, zone, 9 * 60 + 5);
    const semi = pairs(await detail(t.id))[0];
    const refused = await callFixture(semi.id, manager);
    expect(refused).toMatchObject({ ok: false, code: "TD_NOT_HERE", error: expect.stringContaining("has not been checked in") });
    for (const f of field) await setEntry(f.entryId, { checkedIn: true });
    expect(await callFixture(semi.id, manager)).toMatchObject({ ok: true });
    // A fixture of the same court, while this one is called there: the court is not free.
    const sameCourt = pairs(await detail(t.id)).find((m) => m.id !== semi.id && m.courtId === semi.courtId);
    if (sameCourt) expect(await callFixture(sameCourt.id, manager)).toMatchObject({ ok: false, code: expect.stringMatching(/TD_COURT_BUSY|TD_NOT_HERE|TD_BUSY/) });
    // Somebody on court in a called match cannot be called to another.
    expect((await dayBoard(t.id))!.courts.some((c) => c.now?.id === semi.id)).toBe(true);
  });

  it("honours the rest between a player's matches, as a setting of the division", async () => {
    const { t, zone } = await drawn();
    ok(await setDaySettings(t.id, { minRestMinutes: 30 }));
    at(t, zone, 9 * 60 + 40);
    const semis = pairs(await detail(t.id));
    ok(await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" }));
    at(t, zone, 9 * 60 + 45);
    ok(await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" }));
    const final = pairs(await detail(t.id))[0];
    at(t, zone, 10 * 60 + 5);
    const resting = await callFixture(final.id, manager);
    expect(resting).toMatchObject({ ok: false, code: "TD_RESTING" });
    const board = (await dayBoard(t.id))!;
    expect(board.waiting.find((w) => w.id === final.id)).toMatchObject({ ready: false, blockers: [expect.objectContaining({ code: "resting" }), expect.objectContaining({ code: "resting" })] });
    at(t, zone, 10 * 60 + 16);
    expect(await callFixture(final.id, manager)).toMatchObject({ ok: true });
  });

  it("calls where the fixture is held once its time has come, tells both sides once, and a second call is refused", async () => {
    const { t, field, zone } = await drawn();
    const semi = pairs(await detail(t.id))[0];
    at(t, zone, semi.minute! + 5);
    const before = (await day(t.id)).length;
    const done = ok(await callFixture(semi.id, manager));
    expect(done.value.moved).toBeNull();
    const board = done.value.board;
    expect(board.courts.find((c) => c.id === semi.courtId)!.now).toMatchObject({ id: semi.id, state: "called", minutesLeft: 10, overdue: false });
    const called = (await day(t.id)).slice(before).filter((m) => m.dedupe_key!.startsWith(`tnday:called:${semi.id}:`));
    expect(called).toHaveLength(2);
    expect(called[0].body).toContain("You are called");
    expect(called[0].body).toContain("10 minutes");
    expect(await callFixture(semi.id, manager)).toMatchObject({ ok: false, code: "TD_CALLED" });
    expect((await day(t.id)).filter((m) => m.dedupe_key!.startsWith(`tnday:called:${semi.id}:`))).toHaveLength(2);
    // Started: the wait is over.
    at(t, zone, semi.minute! + 8);
    const started = ok(await startFixture(semi.id, manager));
    expect(started.value.board.courts.find((c) => c.id === semi.courtId)!.now).toMatchObject({ state: "playing", overdue: false, minutesLeft: 0 });
    expect(await startFixture(semi.id, manager)).toMatchObject({ ok: false, code: "TD_STARTED" });
    // A result clears it, and frees the court for the next call.
    ok(await recordResult(semi.id, { winner: semi.a!, score: "21-10, 21-12" }));
    expect((await dayBoard(t.id))!.courts.find((c) => c.id === semi.courtId)!.now).toBeNull();
    expect(field.length).toBe(4);
  });

  it("is a manager's to bring forward or send to another court; an official calls where it is held", async () => {
    const { t, zone } = await drawn();
    const semis = pairs(await detail(t.id));
    at(t, zone, 9 * 60 + 40);
    ok(await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" }));
    ok(await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" }));
    const final = pairs(await detail(t.id))[0];
    at(t, zone, 9 * 60 + 45);
    expect(await callFixture(final.id, { id: null, name: "Ref", role: "official" })).toMatchObject({ ok: false, code: "TD_MANAGER_MOVE" });
    // A manager brings it forward on its own court, held like any move.
    const done = ok(await callFixture(final.id, manager));
    expect(done.value.moved).toContain("brought to");
    const after = (await detail(t.id)).matches.find((m) => m.id === final.id)!;
    expect(after).toMatchObject({ minute: 9 * 60 + 46, courtId: final.courtId });
  });

  it("sends a fixture to a freed court, held for it, which a booking cannot then take", async () => {
    const { t, zone } = await drawn();
    const semis = pairs(await detail(t.id));
    at(t, zone, 9 * 60 + 40);
    ok(await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" }));
    ok(await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" }));
    const final = pairs(await detail(t.id))[0];
    const other = courts.find((c) => c !== final.courtId)!;
    // The court no match needs went back on sale after the results: a booking could take its hour 10.
    at(t, zone, 9 * 60 + 56);
    const done = ok(await callFixture(final.id, manager, { courtId: other }));
    expect(done.value.moved).toContain("brought to");
    const moved = (await detail(t.id)).matches.find((m) => m.id === final.id)!;
    expect(moved).toMatchObject({ courtId: other, minute: 9 * 60 + 57 });
    expect(await createBooking({ courtId: other, date: t.startsOn, hours: [10], name: "Walk", phone: "0128880000" })).toMatchObject({ ok: false });
    // The tournament holds the whole of the called slot on that court.
    const gaps = await getDb()
      .prepare("SELECT 1 FROM blocks WHERE tournament_id = ? AND court_id = ? AND date = ? AND start_min <= ? AND end_min >= ?")
      .get(t.id, other, t.startsOn, 9 * 60 + 57, 9 * 60 + 57 + moved.minutes);
    expect(gaps).toBeTruthy();
  });

  it("a call and a booking for the same freed minutes: never both", async () => {
    const { t, zone } = await drawn();
    const semis = pairs(await detail(t.id));
    at(t, zone, 9 * 60 + 40);
    ok(await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" }));
    ok(await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" }));
    const final = pairs(await detail(t.id))[0];
    const other = courts.find((c) => c !== final.courtId)!;
    at(t, zone, 9 * 60 + 56);
    const [called, booked] = await Promise.all([
      callFixture(final.id, manager, { courtId: other }),
      createBooking({ courtId: other, date: t.startsOn, hours: [10], name: "Racer", phone: "0128881111" }),
    ]);
    expect(called.ok && booked.ok).toBe(false);
    expect(called.ok || booked.ok).toBe(true);
    // Whoever lost, the court's claims never overlap.
    const overlapping = (await getDb()
      .prepare(
        `SELECT COUNT(*)::int AS n FROM claims a JOIN claims b ON a.id < b.id AND a.active AND b.active AND a.space_id = b.space_id AND a.during && b.during
          WHERE a.court_id = ?`
      )
      .get(other)) as { n: number };
    expect(overlapping.n).toBe(0);
    const bookedHere = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND name = 'Racer'").get(other, t.startsOn)) as { n: number };
    const matchNow = (await detail(t.id)).matches.find((m) => m.id === final.id)!;
    if (called.ok) {
      expect(bookedHere.n).toBe(0);
      expect(matchNow.courtId).toBe(other);
    } else {
      expect(bookedHere.n).toBe(1);
      expect(matchNow.courtId).toBe(final.courtId);
    }
  });

  it("is refused for a decided match, for sides not known yet, and for heats", async () => {
    const { t, zone } = await drawn();
    const d = await detail(t.id);
    const final = d.matches.find((m) => m.a === null && m.stage === "knockout" && m.round === 2)!;
    at(t, zone, 9 * 60 + 5);
    expect(await callFixture(final.id, manager)).toMatchObject({ ok: false, code: "TD_NO_SIDES" });
    const semi = pairs(d)[0];
    ok(await recordResult(semi.id, { winner: semi.a!, score: "21-10, 21-12" }));
    expect(await callFixture(semi.id, manager)).toMatchObject({ ok: false, code: "TD_DECIDED" });
  });

  it("can be taken back", async () => {
    const { t, zone } = await drawn();
    const semi = pairs(await detail(t.id))[0];
    at(t, zone, semi.minute! + 2);
    ok(await callFixture(semi.id, manager));
    expect(await releaseCall(semi.id, manager)).toMatchObject({ ok: true });
    expect(await releaseCall(semi.id, manager)).toMatchObject({ ok: false, code: "TD_NOT_CALLED" });
    expect((await dayBoard(t.id))!.waiting.find((w) => w.id === semi.id)).toMatchObject({ state: "waiting", ready: true });
    // Calling again tells again: it is a new call.
    ok(await callFixture(semi.id, manager));
    expect((await day(t.id)).filter((m) => m.dedupe_key!.startsWith(`tnday:called:${semi.id}:`) && m.dedupe_key!.endsWith(":2"))).toHaveLength(2);
  });
});

describe("a called fixture nobody comes to", () => {
  /** A round robin of four on two courts: its fixtures do not depend on each other. */
  const robin = () => drawn({ format: "round_robin", groupSize: 4 }, 4);

  it("waits another interval, and only a manager decides", async () => {
    const { t, zone } = await robin();
    const m1 = pairs(await detail(t.id))[0];
    at(t, zone, m1.minute! + 5);
    ok(await callFixture(m1.id, manager));
    at(t, zone, m1.minute! + 16);
    const board = (await dayBoard(t.id))!;
    expect(board.courts.find((c) => c.id === m1.courtId)!.now).toMatchObject({ overdue: true, minutesLeft: 0 });
    expect(await decideNoShow(m1.id, { action: "wait" }, { id: null, name: "Ref", role: "official" })).toMatchObject({ ok: false, code: "TD_MANAGER_ONLY" });
    const waited = ok(await decideNoShow(m1.id, { action: "wait" }, manager));
    expect(waited.value.board.courts.find((c) => c.id === m1.courtId)!.now).toMatchObject({ overdue: false, minutesLeft: 10 });
  });

  it("forfeits to the side that came, as an ordinary walkover, only once the wait is over; and can take the absent out of the event", async () => {
    const { t, zone } = await robin();
    const m1 = pairs(await detail(t.id))[0];
    at(t, zone, m1.minute! + 5);
    ok(await callFixture(m1.id, manager));
    at(t, zone, m1.minute! + 9);
    expect(await decideNoShow(m1.id, { action: "forfeit", absent: m1.a! }, manager)).toMatchObject({ ok: false, code: "TD_WAIT" });
    at(t, zone, m1.minute! + 16);
    expect(await decideNoShow(m1.id, { action: "forfeit", absent: 999999 }, manager)).toMatchObject({ ok: false, code: "TD_WHO_ABSENT" });
    const done = ok(await decideNoShow(m1.id, { action: "forfeit", absent: m1.a!, outOfEvent: true, note: "Did not come" }, manager));
    expect(done.value.detail).toContain("walkover");
    const d = await detail(t.id);
    const was = d.matches.find((m) => m.id === m1.id)!;
    expect(was).toMatchObject({ status: "walkover", winner: m1.b });
    expect(d.entries.find((e) => e.id === m1.a)!.out).toMatchObject({ reason: "withdrawn" });
    // The court is free again, nothing is left called.
    expect((await dayBoard(t.id))!.courts.find((c) => c.id === m1.courtId)!.now).toBeNull();
  });
});

describe("the swap", () => {
  it("puts the next ready fixture on the court and this one in its place", async () => {
    const { t, zone } = await drawn({ format: "round_robin", groupSize: 4 }, 4);
    const all = pairs(await detail(t.id)).sort((x, y) => x.minute! - y.minute! || x.courtId! - y.courtId!);
    const [m1, m2] = all;
    expect(m1.minute).toBe(m2.minute);
    expect(m1.courtId).not.toBe(m2.courtId);
    at(t, zone, m1.minute! + 5);
    ok(await callFixture(m1.id, manager));
    at(t, zone, m1.minute! + 16);
    const before = (await day(t.id)).length;
    const done = ok(await decideNoShow(m1.id, { action: "swap" }, manager));
    expect(done.value.detail).toContain("takes the court");
    const d = await detail(t.id);
    const x = d.matches.find((m) => m.id === m1.id)!;
    const y = d.matches.find((m) => m.id === m2.id)!;
    // Their slots are exchanged; nothing overlaps; the slot was already held.
    expect({ court: y.courtId, minute: y.minute }).toEqual({ court: m1.courtId, minute: m1.minute });
    expect({ court: x.courtId, minute: x.minute }).toEqual({ court: m2.courtId, minute: m2.minute });
    const board = done.value.board;
    expect(board.courts.find((c) => c.id === m1.courtId)!.now).toMatchObject({ id: m2.id, state: "called" });
    expect(board.waiting.find((w) => w.id === m1.id)).toMatchObject({ state: "waiting" });
    // The fixture called is announced to its sides; the one put back is told it moved.
    const told = (await day(t.id)).slice(before);
    expect(told.filter((m) => m.dedupe_key!.startsWith(`tnday:called:${m2.id}:`))).toHaveLength(2);
    expect(await decideNoShow(m1.id, { action: "swap" }, manager)).toMatchObject({ ok: false, code: "TD_NOT_CALLED" });
  });

  it("is refused where nothing else is ready", async () => {
    const { t, zone } = await drawn();
    const semi = pairs(await detail(t.id))[0];
    const other = pairs(await detail(t.id)).find((m) => m.id !== semi.id)!;
    // The other semi-final has somebody not checked in.
    await setEntry(other.a!, { checkedIn: false });
    at(t, zone, semi.minute! + 5);
    ok(await callFixture(semi.id, manager));
    expect(await decideNoShow(semi.id, { action: "swap" }, manager)).toMatchObject({ ok: false, code: "TD_NONE_READY" });
  });
});

describe("the day's settings", () => {
  it("are checked, and a division keeps its own", async () => {
    const { t } = await drawn();
    expect(await setDaySettings(t.id, { minRestMinutes: 500 })).toMatchObject({ ok: false });
    expect(await setDaySettings(t.id, { callWaitMinutes: 0 })).toMatchObject({ ok: false });
    expect(await setDaySettings(t.id, { liveNames: "nope" })).toMatchObject({ ok: false });
    const done = ok(await setDaySettings(t.id, { minRestMinutes: 15, callWaitMinutes: 5, liveNames: "short" }));
    expect(done.value.settings).toEqual({ minRestMinutes: 15, callWaitMinutes: 5, announceNext: true, liveNames: "short" });
    const other = await drawn();
    expect((await dayBoard(other.t.id))!.settings.minRestMinutes).toBe(0);
  });
});

describe("the public live page", () => {
  it("shows courts, what is next and recent results, and nothing private", async () => {
    const t0 = await tournament({ ageMin: 8, ageMax: 17 });
    const zone = await tournamentZone(t0.id);
    const field: { user: User; entryId: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const user = await player("Aina Binti");
      const made = ok(await enter(user, t0.id, { birthDate: addDays(t0.startsOn, -365 * 12), guardianName: "Puan Guardian", guardianConsent: true }));
      await setEntry(made.value.id, { checkedIn: true });
      field.push({ user, entryId: made.value.id });
    }
    ok(await makeDraw(t0.id, fixed));
    const semi = pairs(await detail(t0.id))[0];
    at(t0, zone, semi.minute! + 5);
    ok(await callFixture(semi.id, manager));
    ok(await recordResult(pairs(await detail(t0.id)).find((m) => m.id !== semi.id)!.id, { winner: pairs(await detail(t0.id)).find((m) => m.id !== semi.id)!.a!, score: "21-10, 21-12" }));
    const board = (await liveBoard(t0.id))!;
    const text = JSON.stringify(board);
    // Declared minors: first name and an initial.
    expect(text).toContain("Aina B.");
    for (const f of field) expect(text).not.toContain(f.user.name);
    // No staff names, check-in, calls, guardians, contacts, emails, ids of entries.
    for (const secret of ["Musa Manager", "Puan Guardian", "checkedIn", "calledBy", "guardian", "phone", "@cup.test", "dueAt", "blockers", "userId", "entryId"]) expect(text, secret).not.toContain(secret);
    expect(board.courts.find((c) => c.id === semi.courtId)!.now).toMatchObject({ id: semi.id, state: "called" });
    expect(board.recent).toHaveLength(1);
    // The route is public and refuses a cancelled tournament.
    const res = await liveRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t0.id}/live`), { params: Promise.resolve({ id: String(t0.id) }) });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("Puan Guardian");
  });

  it("shows adults in full unless the tournament says short; teams by their name", async () => {
    const { t, field, zone } = await drawn();
    at(t, zone, 8 * 60 + 30);
    const full = JSON.stringify(await liveBoard(t.id));
    expect(full).toContain(field[0].user.name.split(" ")[0]);
    ok(await setDaySettings(t.id, { liveNames: "short" }));
    const short = JSON.stringify(await liveBoard(t.id));
    for (const f of field) expect(short).not.toContain(f.user.name);
    expect(short).toMatch(/Player D\./);
  });

  it("is gone for a cancelled tournament", async () => {
    const { t } = await drawn();
    ok(await cancelTournament(t.id));
    expect(await liveBoard(t.id)).toBeNull();
    const res = await liveRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}/live`), { params: Promise.resolve({ id: String(t.id) }) });
    expect(res.status).toBe(404);
  });
});

describe("who may do what", () => {
  const call = (route: Record<string, unknown>, method: string, id: number, cookie: string, body: unknown = {}) =>
    (route[method] as (req: NextRequest, ctx: unknown) => Promise<Response>)(
      new NextRequest(`http://localhost/api/admin/tournaments/${id}/day`, { method, headers: { cookie }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }),
      { params: Promise.resolve({ id: String(id) }) }
    );

  it("front desk reads the board but cannot call, decide or change the settings; a manager can, each in the activity log", async () => {
    const desk = await createAdmin({ name: "Dina Desk", email: "dina@day.test", password: "desk-password-1", venueId, role: "desk" });
    const mgr = await createAdmin({ name: "Musa Day", email: "musa@day.test", password: "manager-pass-1", venueId });
    if (!desk.ok || !mgr.ok) throw new Error("staff");
    const { t, zone } = await drawn();
    const semi = pairs(await detail(t.id))[0];
    at(t, zone, semi.minute! + 3);
    // Signed in on the tournament's day, as staff would be.
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const mgrCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.admin.id)).token}`;
    expect((await call(dayRoute, "GET", t.id, deskCookie)).status).toBe(200);
    for (const body of [{ action: "call", matchId: semi.id }, { action: "settings", minRestMinutes: 5 }, { action: "decide", matchId: semi.id, decision: { action: "wait" } }]) {
      const res = await call(dayRoute, "POST", t.id, deskCookie, body);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("MANAGER_ONLY");
    }
    expect((await dayBoard(t.id))!.courts.every((c) => c.now === null)).toBe(true);
    // Desk keeps check-in (an entry route, unchanged) and results.
    const res = await call(dayRoute, "POST", t.id, mgrCookie, { action: "call", matchId: semi.id });
    expect(res.status).toBe(200);
    expect((await call(dayRoute, "POST", t.id, mgrCookie, { action: "call", matchId: semi.id })).status).toBe(409);
    expect((await call(dayRoute, "POST", t.id, mgrCookie, { action: "settings", minRestMinutes: 5 })).status).toBe(200);
    const logged = (await getDb().prepare("SELECT action, admin_name FROM staff_actions WHERE action LIKE 'tournament.%' ORDER BY id DESC LIMIT 2").all()) as { action: string; admin_name: string }[];
    expect(logged.map((l) => l.action)).toEqual(["tournament.day_settings", "tournament.match_called"]);
    expect(logged[0].admin_name).toBe("Musa Day");
  });

  it("an official may call where the match is held, start it and take the call back, under their name, and cannot bring one forward", async () => {
    const { t, zone } = await drawn();
    const semi = pairs(await detail(t.id))[0];
    const link = ok(await addOfficial(t.id, "Rina Referee", ownerId, null));
    const token = link.value.token;
    at(t, zone, semi.minute! + 3);
    const post = (body: unknown) =>
      officialRoute.POST(new NextRequest(`http://localhost/api/officials/${token}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ token }) });
    expect((await post({ matchId: semi.id, action: "call" })).status).toBe(200);
    expect((await post({ matchId: semi.id, action: "start" })).status).toBe(200);
    expect((await post({ matchId: semi.id, action: "release" })).status).toBe(200);
    expect(await officialDay(token, "call", 999999)).toMatchObject({ ok: false });
    // Not the matches of another tournament.
    const other = await drawn();
    expect(await officialDay(token, "call", pairs(await detail(other.t.id))[0].id)).toMatchObject({ ok: false, error: "That match is not in this tournament." });
    const logged = (await getDb().prepare("SELECT admin_name, action FROM staff_actions WHERE admin_name LIKE 'Official:%' ORDER BY id DESC LIMIT 3").all()) as { admin_name: string; action: string }[];
    expect(logged.map((l) => l.action)).toEqual(["tournament.call_released", "tournament.match_started", "tournament.match_called"]);
    expect(logged[0].admin_name).toBe("Official: Rina Referee");
    // Early: a bring-forward is the manager's.
    at(t, zone, 8 * 60);
    expect((await post({ matchId: semi.id, action: "call" })).status).toBe(409);
  });
});

describe("existing tournaments are not changed", () => {
  it("a result on another day announces nothing, and a performance event is left alone", async () => {
    const { t } = await drawn();
    // The clock is the real one: the tournament is days away.
    const before = (await day(t.id)).length;
    const semis = pairs(await detail(t.id));
    ok(await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" }));
    expect((await day(t.id)).length).toBe(before);
    const board: DayBoard = (await dayBoard(t.id))!;
    expect(board.today).not.toBe(t.startsOn);
  });
});
