import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sent: { to: string; subject: string; text: string }[] = [];
// Programme emails are queued (lib/outbox.ts, emailPlayer); each one queued is also noted here, as sent.
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    emailPlayer: async (input: Parameters<typeof real.emailPlayer>[0]) => {
      await real.emailPlayer(input);
      const { getDb } = await import("../src/lib/db");
      const queued = (await getDb()
        .prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'programme' ORDER BY id DESC LIMIT 1")
        .get()) as { recipient: string; subject: string; body: string } | undefined;
      if (queued) sent.push({ to: queued.recipient, subject: queued.subject, text: queued.body });
    },
  };
});

import { createOutage } from "../src/lib/outages";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { markRefunded, refundsOwed, savePaymentSettings, settleBill, startEntryPayment } from "../src/lib/payments";
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
  takeOut,
  previewTakeOut,
  previewResult,
  applyCorrection,
  setRules,
  reviewIssue,
  resolveIssue,
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
    // Taken out as staff would: the outage takes the tournament's hold on that court with it.
    expect(await createOutage({ courtId: courts[1], startsOn: t.startsOn, endsOn: t.startsOn, reason: "Net torn", adminId: ownerId })).toMatchObject({ ok: true });
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
    const left = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE tournament_id = ?").get(t.id)) as { n: number };
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

/** A tournament of two groups of three, top two through to semi-finals, drawn. */
async function groupsCup() {
  const t = await tournament({ format: "groups", groupSize: 3, advance: 2 });
  const field = await entries(t.id, 6);
  const drawn = await makeDraw(t.id, fixed);
  if (!drawn.ok) throw new Error(drawn.error);
  return { t, field };
}

/** Every group match still to play, the side named first winning. */
async function playGroups(id: number) {
  for (const m of (await tournamentDetail(id))!.matches.filter((x) => x.stage === "group" && x.status === "scheduled")) {
    const r = await recordResult(m.id, { winner: m.a!, score: "21-15, 21-15" });
    if (!r.ok) throw new Error(r.error);
  }
  return (await tournamentDetail(id))!;
}

const semiLines = (d: Awaited<ReturnType<typeof tournamentDetail>>) =>
  d!.matches.filter((m) => m.stage === "knockout" && m.round === 1).sort((a, b) => a.position - b.position).map((m) => [m.a, m.b]);

/** Who the groups should send through, by the tables as they stand: the first in each still in. */
const expectedLines = (d: Awaited<ReturnType<typeof tournamentDetail>>) => {
  const [g1, g2] = d!.groups.map((g) => g.table.filter((x) => !x.out).map((x) => x.entryId));
  return [
    [g1[0], g2[1]],
    [g2[0], g1[1]],
  ];
};

/** The group match between the second and third in group one, and the result that swaps them. */
function swapSecondAndThird(d: Awaited<ReturnType<typeof tournamentDetail>>) {
  const [, second, third] = d!.groups[0].table.map((x) => x.entryId);
  const m = d!.matches.find((x) => x.stage === "group" && [x.a, x.b].includes(second) && [x.a, x.b].includes(third))!;
  expect(m.winner).toBe(second);
  return { m, second, third, swap: { winner: third, score: m.a === third ? "21-15, 21-15" : "15-21, 15-21" } };
}

describe("a group result put right after the knockout is filled (B9)", () => {
  it("fills the knockout again, while none of it has been played", async () => {
    const { t } = await groupsCup();
    const before = await playGroups(t.id);
    expect(semiLines(before)).toEqual(expectedLines(before));
    const { m, second, third, swap } = swapSecondAndThird(before);
    expect(semiLines(before).flat()).toContain(second);
    expect(semiLines(before).flat()).not.toContain(third);

    const fixedUp = await recordResult(m.id, swap);
    if (!fixedUp.ok) throw new Error(fixedUp.error);
    // The knockout follows the tables as they now stand.
    expect(fixedUp.value.groups[0].table.map((x) => x.entryId).slice(0, 2)).toContain(third);
    expect(semiLines(fixedUp.value)).toEqual(expectedLines(fixedUp.value));
    expect(semiLines(fixedUp.value).flat()).toContain(third);
    expect(semiLines(fixedUp.value).flat()).not.toContain(second);
    expect((await playOut(t.id)).status).toBe("finished");
  });

  it("is refused once a knockout match is played, if it would change who is in it; a score put right still goes in", async () => {
    const { t } = await groupsCup();
    const before = await playGroups(t.id);
    const semi = before.matches.find((x) => x.stage === "knockout" && x.round === 1)!;
    expect((await recordResult(semi.id, { winner: semi.a!, score: "21-10, 21-10" })).ok).toBe(true);
    const played = (await tournamentDetail(t.id))!;

    const { m, swap } = swapSecondAndThird(played);
    const refused = await recordResult(m.id, swap);
    expect(refused).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    // Nothing of it was kept: the group result and the knockout are as they were.
    const after = (await tournamentDetail(t.id))!;
    expect(after.matches.find((x) => x.id === m.id)).toMatchObject({ winner: m.winner, score: m.score });
    expect(semiLines(after)).toEqual(semiLines(played));
    expect(after.matches.find((x) => x.id === semi.id)).toMatchObject({ status: "done", winner: semi.a });

    // The same winner with a different score changes nobody's place.
    const scoreOnly = await recordResult(m.id, { winner: m.winner!, score: m.a === m.winner ? "21-19, 21-19" : "19-21, 19-21" });
    expect(scoreOnly.ok).toBe(true);
    expect(semiLines((await tournamentDetail(t.id))!)).toEqual(semiLines(played));
  });

  it("is written to the activity log, with the result it replaced and the knockout before and after", async () => {
    const { t } = await groupsCup();
    const before = await playGroups(t.id);
    const { m, swap } = swapSecondAndThird(before);
    const owner = (await listAdmins())[0];
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const route = await import("../src/app/api/admin/tournaments/[id]/matches/[matchId]/route");
    const res = await route.POST(
      new NextRequest(`http://localhost/api/admin/tournaments/${t.id}/matches/${m.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(swap),
      }),
      { params: Promise.resolve({ id: String(t.id), matchId: String(m.id) }) }
    );
    expect(res.status).toBe(200);
    const logged = (await getDb()
      .prepare("SELECT action, detail FROM staff_actions WHERE detail LIKE ? ORDER BY id")
      .all(`${t.name}%`)) as { action: string; detail: string }[];
    expect(logged.map((l) => l.action)).toEqual(["tournament.result_changed", "tournament.knockout_refilled"]);
    expect(logged[0].detail).toContain("(was: ");
    expect(logged[1].detail).toContain("(was: ");
  });
});

describe("a withdrawal after the draw (B10)", () => {
  it("in the groups: their matches left are walkovers, their results stand where they put them, flagged, and they do not go through", async () => {
    const { t } = await groupsCup();
    let d = (await tournamentDetail(t.id))!;
    // They win their first match, then withdraw.
    const first = d.matches.find((x) => x.stage === "group" && x.groupNo === 1)!;
    const quitter = first.a!;
    expect((await recordResult(first.id, { winner: quitter, score: "21-5, 21-5" })).ok).toBe(true);
    expect((await withdraw(quitter)).ok).toBe(true);
    d = (await tournamentDetail(t.id))!;
    const theirs = d.matches.filter((x) => x.stage === "group" && [x.a, x.b].includes(quitter));
    expect(theirs.filter((x) => x.id !== first.id).every((x) => x.status === "walkover" && x.winner !== quitter)).toBe(true);
    // The win they had stands as played, but they are last, under everybody still in.
    expect(d.matches.find((x) => x.id === first.id)).toMatchObject({ status: "done", winner: quitter });
    d = await playGroups(t.id);
    // Not moved to the bottom: shown where their results put them, marked out, not ranked through.
    const row = d.groups[0].table.find((x) => x.entryId === quitter)!;
    expect(row).toMatchObject({ out: "withdrawn", resultsVoid: false, won: 1 });
    expect(d.entries.find((e) => e.id === quitter)!.out).toEqual({ reason: "withdrawn", stage: "groups" });
    expect(semiLines(d).flat()).not.toContain(quitter);
    expect(semiLines(d)).toEqual(expectedLines(d));
    expect((await playOut(t.id)).status).toBe("finished");
  });

  it("with the knockout filled and none of it played: filled again without them", async () => {
    const { t } = await groupsCup();
    const filled = await playGroups(t.id);
    const quitter = semiLines(filled)[0][0]!;
    expect((await withdraw(quitter)).ok).toBe(true);
    const d = (await tournamentDetail(t.id))!;
    expect(semiLines(d).flat()).not.toContain(quitter);
    expect(semiLines(d)).toEqual(expectedLines(d));
    // Nobody in the knockout had a walkover handed to them: it is all still to play.
    expect(d.matches.filter((x) => x.stage === "knockout").every((x) => x.status === "scheduled")).toBe(true);
  });

  it("in the knockout before their opponent is known: a walkover as soon as they are", async () => {
    const t = await tournament();
    await entries(t.id, 4);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    const [s1, s2] = drawn.value.matches.filter((x) => x.round === 1).sort((a, b) => a.position - b.position);
    expect((await recordResult(s1.id, { winner: s1.a!, score: "21-10, 21-10" })).ok).toBe(true);
    expect((await withdraw(s1.a!)).ok).toBe(true);
    let final = (await tournamentDetail(t.id))!.matches.find((x) => x.round === 2)!;
    // Their opponent is still being decided: the final waits.
    expect(final).toMatchObject({ status: "scheduled", winner: null });
    expect((await recordResult(s2.id, { winner: s2.b!, score: "10-21, 10-21" })).ok).toBe(true);
    const d = (await tournamentDetail(t.id))!;
    final = d.matches.find((x) => x.round === 2)!;
    expect(final).toMatchObject({ status: "walkover", winner: s2.b });
    expect(d.status).toBe("finished");
  });

  it("when nobody is left on either side, nobody goes through, and the one still in wins it", async () => {
    const { t, field } = await groupsCup();
    const d0 = (await tournamentDetail(t.id))!;
    const groupOf = (entryId: number) => d0.matches.find((x) => x.stage === "group" && [x.a, x.b].includes(entryId))!.groupNo;
    const g1 = field.filter((f) => groupOf(f.entryId) === 1);
    const g2 = field.filter((f) => groupOf(f.entryId) === 2);
    // All of group one and two of group two withdraw.
    for (const f of [...g1, ...g2.slice(0, 2)]) expect((await withdraw(f.entryId)).ok).toBe(true);
    const d = await playGroups(t.id);
    expect(d.status).toBe("finished");
    const final = d.matches.find((x) => x.stage === "knockout" && x.round === 2)!;
    expect(final.winner).toBe(g2[2].entryId);
    expect(d.matches.filter((x) => x.stage === "knockout").every((x) => x.status === "bye" || x.status === "walkover")).toBe(true);
  });
});

describe("how a tournament treats somebody who leaves (its rules)", () => {
  /** The group-one match the given entrant won, if any, and the one they lost. */
  const groupOne = (d: Awaited<ReturnType<typeof tournamentDetail>>) => d!.matches.filter((x) => x.stage === "group" && x.groupNo === 1);

  it("a disqualification voids their group results for everybody, by default; they are listed, unranked, after the rest", async () => {
    const { t } = await groupsCup();
    let d = (await tournamentDetail(t.id))!;
    const first = groupOne(d)[0];
    const cheat = first.a!;
    const beaten = first.b!;
    expect((await recordResult(first.id, { winner: cheat, score: "21-5, 21-5" })).ok).toBe(true);
    const done = await takeOut(cheat, "disqualified", "Played with an illegal racket");
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.changes.join(" ")).toMatch(/is out \(disqualified, in the groups\)\. Their group results no longer count/);
    d = await playGroups(t.id);
    const table = d.groups[0].table;
    // Their win over `beaten` is gone: of `beaten`'s two group matches, only the one against somebody else counts.
    expect(table.find((x) => x.entryId === beaten)!.played).toBe(1);
    expect(table.at(-1)).toMatchObject({ entryId: cheat, out: "disqualified", resultsVoid: true, won: 0, played: 0 });
    expect(semiLines(d).flat()).not.toContain(cheat);
    expect(semiLines(d)).toEqual(expectedLines(d));
  });

  it("can void a withdrawal's results too, where the tournament says so; not once the draw is made", async () => {
    const t = await tournament({ format: "groups", groupSize: 3, advance: 2 });
    expect((await setRules(t.id, { groupResultsOnWithdrawal: "void" })).ok).toBe(true);
    expect((await setRules(t.id, { groupResultsOnWithdrawal: "sometimes" })).ok).toBe(false);
    await entries(t.id, 6);
    expect((await makeDraw(t.id, fixed)).ok).toBe(true);
    expect((await setRules(t.id, { groupResultsOnWithdrawal: "stand" })).ok).toBe(false);
    let d = (await tournamentDetail(t.id))!;
    expect(d.rules.groupResultsOnWithdrawal).toBe("void");
    const first = groupOne(d)[0];
    expect((await recordResult(first.id, { winner: first.a!, score: "21-5, 21-5" })).ok).toBe(true);
    expect((await withdraw(first.a!)).ok).toBe(true);
    d = (await tournamentDetail(t.id))!;
    expect(d.groups[0].table.find((x) => x.entryId === first.a)).toMatchObject({ resultsVoid: true, played: 0 });
  });

  it("a retirement part-way: won by the other side with the score as it stood, counted as a win; out of the event if the organiser says", async () => {
    const { t } = await groupsCup();
    let d = (await tournamentDetail(t.id))!;
    const m = groupOne(d)[0];
    // Leading when they stopped: the score says the other side was ahead, and that is fine for a retirement.
    const r = await recordResult(m.id, { winner: m.b!, score: "21-15, 5-2", retired: true, outOfEvent: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    d = (await tournamentDetail(t.id))!;
    expect(d.matches.find((x) => x.id === m.id)).toMatchObject({ status: "retired", winner: m.b, score: "21-15, 5-2" });
    expect(d.entries.find((e) => e.id === m.a)!.out).toEqual({ reason: "retired", stage: "groups" });
    // Their other group match is a walkover; the retirement counts as a win, with no sets either way.
    expect(groupOne(d).filter((x) => x.id !== m.id && [x.a, x.b].includes(m.a)).every((x) => x.status === "walkover")).toBe(true);
    const winnerRow = d.groups[0].table.find((x) => x.entryId === m.b)!;
    expect(winnerRow.won).toBeGreaterThanOrEqual(1);
    // Without a retirement, a score that says the other side won is still refused.
    const other = groupOne(d).find((x) => x.status === "scheduled")!;
    expect((await recordResult(other.id, { winner: other.a!, score: "5-21, 5-21" })).ok).toBe(false);
  });

  it("says what taking somebody out would change, and changes nothing until asked", async () => {
    const { t } = await groupsCup();
    const filled = await playGroups(t.id);
    const quitter = semiLines(filled)[0][0]!;
    const preview = await previewTakeOut(quitter, "withdrawn");
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.changes.some((c) => /is out \(withdrawn/.test(c))).toBe(true);
    expect(preview.value.changes.some((c) => /Semi-final 1: now/.test(c))).toBe(true);
    // Nothing changed.
    const still = (await tournamentDetail(t.id))!;
    expect(still.entries.find((e) => e.id === quitter)!.out).toBeNull();
    expect(semiLines(still)).toEqual(semiLines(filled));
  });

  it("keeps a fee paid online before the draw where the rules say no refund", async () => {
    const t = await tournament();
    expect((await setRules(t.id, { refundBeforeDraw: false })).ok).toBe(true);
    const [only] = await entries(t.id, 1);
    await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, purpose, tournament_entry_id)
         VALUES ('stripe', 'cs_norefund', 'https://x', ?, 20, 'paid', 'Kept', 'entry', ?)`
      )
      .run(venueId, only.entryId);
    expect((await withdraw(only.entryId)).ok).toBe(true);
    const due = (await getDb().prepare("SELECT refund_due::float AS d FROM online_payments WHERE bill_id = 'cs_norefund'").get()) as { d: number };
    expect(due.d).toBe(0);
  });
});

describe("correcting a group result after the knockout has begun", () => {
  async function underway(playFirstSemi = true) {
    const { t } = await groupsCup();
    const before = await playGroups(t.id);
    const { m, second, third, swap } = swapSecondAndThird(before);
    const semis = before.matches.filter((x) => x.stage === "knockout" && x.round === 1).sort((a, b) => a.position - b.position);
    // Group one's runner-up plays in semi-final 2 (the other half from its winner).
    const affected = semis.find((x) => [x.a, x.b].includes(second))!;
    const unaffected = semis.find((x) => x.id !== affected.id)!;
    if (playFirstSemi) expect((await recordResult(unaffected.id, { winner: unaffected.a!, score: "21-10, 21-10" })).ok).toBe(true);
    return { t, m, second, third, swap, affected, unaffected };
  }

  it("is previewed fixture by fixture, then made in the knockout where the match it changes is still to play, kept with its reason", async () => {
    const { t, m, second, third, swap, affected } = await underway();
    expect(await recordResult(m.id, swap)).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    const preview = await previewResult(m.id, swap);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.needsCorrection).toBe(true);
    expect(preview.value.replace.possible).toBe(true);
    if (!preview.value.replace.possible) return;
    expect(preview.value.replace.changes.join(" ")).toMatch(/Semi-final \d: now .* \(was .*\)/);
    // The preview changed nothing.
    expect((await tournamentDetail(t.id))!.matches.find((x) => x.id === affected.id)).toMatchObject({ a: affected.a, b: affected.b });

    const owner = (await listAdmins())[0];
    expect(await applyCorrection(m.id, swap, { mode: "replace", reason: "x", token: preview.value.token }, owner)).toMatchObject({ ok: false });
    const done = await applyCorrection(m.id, swap, { mode: "replace", reason: "Scorer swapped the names on the sheet", token: preview.value.token }, owner);
    expect(done.ok, done.ok ? "" : done.error).toBe(true);
    if (!done.ok) return;
    const semi = done.value.detail.matches.find((x) => x.id === affected.id)!;
    expect([semi.a, semi.b]).toContain(third);
    expect([semi.a, semi.b]).not.toContain(second);
    // Kept: what changed, what it was, who and why. The public sees that a correction was made, not why.
    const kept = (await getDb()
      .prepare("SELECT kind, reason, admin_name, before_state FROM tournament_corrections WHERE tournament_id = ?")
      .get(t.id)) as { kind: string; reason: string; admin_name: string; before_state: string };
    expect(kept).toMatchObject({ kind: "replace", reason: "Scorer swapped the names on the sheet", admin_name: owner.name });
    expect((JSON.parse(kept.before_state) as { id: number; a: number; b: number }[]).find((x) => x.id === affected.id)).toMatchObject({ a: affected.a, b: affected.b });
    const publicView = (await tournamentDetail(t.id))!;
    expect(publicView.corrections).toEqual([{ kind: "replace", knockout: false, createdAt: expect.any(String) }]);
    expect((await tournamentDetail(t.id, { forStaff: true }))!.corrections[0].reason).toBe("Scorer swapped the names on the sheet");
  });

  it("is blocked from the knockout when the match it changes has been played: corrected in the table only, the knockout stands as played", async () => {
    const { m, swap, affected } = await underway();
    expect((await recordResult(affected.id, { winner: affected.a!, score: "21-10, 21-10" })).ok).toBe(true);
    const preview = await previewResult(m.id, swap);
    expect(preview.ok && preview.value.replace.possible).toBe(false);
    if (!preview.ok || preview.value.replace.possible) return;
    expect(preview.value.replace.blockers.join(" ")).toMatch(/has been decided: it would need replaying/);
    const owner = (await listAdmins())[0];
    expect(await applyCorrection(m.id, swap, { mode: "replace", reason: "Appeal upheld", token: preview.value.token }, owner)).toMatchObject({ ok: false, code: "BLOCKED" });
    const done = await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Appeal upheld after the semi-final", token: preview.value.token }, owner);
    expect(done.ok, done.ok ? "" : done.error).toBe(true);
    if (!done.ok) return;
    expect(done.value.detail.matches.find((x) => x.id === m.id)!.winner).toBe(swap.winner);
    // The knockout is as it was played.
    expect(done.value.detail.matches.find((x) => x.id === affected.id)).toMatchObject({ status: "done", a: affected.a, b: affected.b });
    expect(done.value.detail.corrections.map((c) => c.kind)).toEqual(["standings_only"]);
    // The semi-final was played by the competitor the tables no longer send: flagged for the organiser.
    const second = affected.a === swap.winner ? affected.b : [affected.a, affected.b].find((x) => x !== swap.winner);
    expect(done.value.detail.issues).toEqual([expect.objectContaining({ status: "open", fromMatchId: affected.id, rightEntry: swap.winner })]);
    expect([affected.a, affected.b]).toContain(done.value.detail.issues[0].wrongEntry);
    expect(second).toBeDefined();
  });

  it("of a knockout match whose next match is played: its record put right, the later rounds as they were played", async () => {
    const t = await tournament();
    await entries(t.id, 4);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    const [semi, other] = drawn.value.matches.filter((x) => x.round === 1).sort((a, b) => a.position - b.position);
    expect((await recordResult(semi.id, { winner: semi.a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await recordResult(other.id, { winner: other.a!, score: "21-10, 21-12" })).ok).toBe(true);
    const final = (await tournamentDetail(t.id))!.matches.find((x) => x.round === 2)!;
    expect((await recordResult(final.id, { winner: semi.a!, score: "21-18, 21-19" })).ok).toBe(true);

    // The semi-final's sheet had the names the wrong way round.
    const swap = { winner: semi.b!, score: "10-21, 12-21" };
    expect(await recordResult(semi.id, swap)).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    const preview = await previewResult(semi.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.needsCorrection).toBe(true);
    expect(preview.value.replace).toMatchObject({ possible: false, blockers: [expect.stringMatching(/stands as played/)] });
    expect(preview.value.standingsOnly.changes.join(" ")).toMatch(/Semi-final 1/);
    const owner = (await listAdmins())[0];
    expect(await applyCorrection(semi.id, swap, { mode: "replace", reason: "Names swapped on the sheet", token: preview.value.token }, owner)).toMatchObject({ ok: false });
    const done = await applyCorrection(semi.id, swap, { mode: "standings_only", reason: "Names swapped on the sheet", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    expect(done.value.detail.matches.find((x) => x.id === semi.id)).toMatchObject({ winner: semi.b, score: "10-21, 12-21" });
    // Who went on, and the final they played, are not rewritten.
    expect(done.value.detail.matches.find((x) => x.id === final.id)).toMatchObject({ a: final.a, b: final.b, winner: semi.a, status: "done" });
    expect(done.value.detail.corrections).toEqual([expect.objectContaining({ kind: "standings_only", knockout: true, reason: "Names swapped on the sheet" })]);
    // But the bracket is not quietly left wrong: the wrong side played the final, so it is under review and not finished.
    expect(preview.value.issuesIfStandingsOnly?.join(" ")).toMatch(/Final: .* played instead of/);
    expect(done.value.detail.status).toBe("drawn");
    expect(done.value.detail.issues).toEqual([
      expect.objectContaining({ status: "open", fromMatchId: final.id, wrongEntry: semi.a, rightEntry: semi.b, affected: [expect.objectContaining({ matchId: final.id, played: true })] }),
    ]);
    expect(done.value.changes.join(" ")).toMatch(/Under review/);
  });

  it("is refused against a preview of a tournament that has since changed", async () => {
    const { t, m, swap, affected } = await underway();
    const preview = await previewResult(m.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    // Meanwhile a knockout result goes in.
    expect((await recordResult(affected.id, { winner: affected.a!, score: "21-10, 21-10" })).ok).toBe(true);
    const owner = (await listAdmins())[0];
    expect(await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Scoring mistake", token: preview.value.token }, owner)).toMatchObject({
      ok: false,
      code: "CHANGED",
    });
    expect((await tournamentDetail(t.id))!.matches.find((x) => x.id === m.id)!.winner).toBe(m.winner);
  });

  it("is a manager's: front desk staff are refused", async () => {
    const { t, m, swap } = await underway();
    const preview = await previewResult(m.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const desk = await createAdmin({ name: "Desk Cup", email: `desk${Date.now()}@cup.my`, password: "desk-password", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const route = await import("../src/app/api/admin/tournaments/[id]/matches/[matchId]/route");
    const res = await route.POST(
      new NextRequest(`http://localhost/api/admin/tournaments/${t.id}/matches/${m.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ ...swap, correction: { mode: "standings_only", reason: "Desk tries", token: preview.value.token } }),
      }),
      { params: Promise.resolve({ id: String(t.id), matchId: String(m.id) }) }
    );
    expect(res.status).toBe(403);
  });
});

describe("progression a correction left wrong", () => {
  /** A finished four-player knockout whose first semi-final's sheet had the names swapped, corrected in the record only. */
  async function wrongFinal() {
    const t = await tournament();
    await entries(t.id, 4);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    const [semi, other] = drawn.value.matches.filter((x) => x.round === 1).sort((a, b) => a.position - b.position);
    expect((await recordResult(semi.id, { winner: semi.a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await recordResult(other.id, { winner: other.a!, score: "21-10, 21-12" })).ok).toBe(true);
    const final = (await tournamentDetail(t.id))!.matches.find((x) => x.round === 2)!;
    expect((await recordResult(final.id, { winner: semi.a!, score: "21-18, 21-19" })).ok).toBe(true);
    expect((await tournamentDetail(t.id))!.status).toBe("finished");
    const swap = { winner: semi.b!, score: "10-21, 12-21" };
    const preview = await previewResult(semi.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const owner = (await listAdmins())[0];
    const done = await applyCorrection(semi.id, swap, { mode: "standings_only", reason: "Names swapped on the sheet", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    return { t, semi, other, final, owner, issue: done.value.detail.issues[0] };
  }

  it("does not finish while it is open, whatever else is played", async () => {
    const { t, issue } = await wrongFinal();
    expect(issue.status).toBe("open");
    const d = (await tournamentDetail(t.id))!;
    expect(d.status).toBe("drawn");
    expect(d.matches.every((m) => m.status !== "scheduled")).toBe(true);
  });

  it("can be let stand, with a reason, against what was reviewed: the results as played, recorded so, then finished", async () => {
    const { final, owner, issue, semi } = await wrongFinal();
    const review = await reviewIssue(issue.id);
    if (!review.ok) throw new Error(review.error);
    expect(review.value.replay).toMatchObject({ possible: true, matches: [{ matchId: final.id, needsSlot: true }] });
    expect(await resolveIssue(issue.id, { action: "stand", reason: "no", token: review.value.token }, owner)).toMatchObject({ ok: false });
    expect(await resolveIssue(issue.id, { action: "stand", reason: "Both finalists agreed", token: "stale" }, owner)).toMatchObject({ ok: false, code: "CHANGED" });
    const done = await resolveIssue(issue.id, { action: "stand", reason: "Both finalists agreed the final stands", token: review.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    expect(done.value.detail.status).toBe("finished");
    expect(done.value.detail.issues[0]).toMatchObject({ status: "stood", resolutionReason: "Both finalists agreed the final stands" });
    expect(done.value.detail.matches.find((m) => m.id === final.id)).toMatchObject({ winner: semi.a, status: "done" });
    expect(done.value.detail.corrections.map((c) => c.kind)).toEqual(["standings_only", "stand"]);
    // Resolved once.
    expect(await resolveIssue(issue.id, { action: "stand", reason: "Again, by mistake", token: review.value.token }, owner)).toMatchObject({ ok: false });
  });

  it("can be replayed at a court and time the tournament holds: the right side in the final, what was played kept in the record", async () => {
    const { t, final, owner, issue, semi } = await wrongFinal();
    const review = await reviewIssue(issue.id);
    if (!review.ok) throw new Error(review.error);
    // A replay needs its court and time.
    expect(await resolveIssue(issue.id, { action: "replay", reason: "Final replayed with the right finalist", token: review.value.token }, owner)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/court and a time/),
    });
    const slot = { courtId: final.courtId!, date: final.date!, startMin: final.minute! };
    const done = await resolveIssue(issue.id, { action: "replay", reason: "Final replayed with the right finalist", token: review.value.token, slots: { [final.id]: slot } }, owner);
    if (!done.ok) throw new Error(done.error);
    const replay = done.value.detail.matches.find((m) => m.id === final.id)!;
    expect(replay).toMatchObject({ status: "scheduled", winner: null, score: null, courtId: slot.courtId, date: slot.date, minute: slot.startMin });
    expect([replay.a, replay.b]).toContain(semi.b);
    expect([replay.a, replay.b]).not.toContain(semi.a);
    expect(done.value.detail.issues[0].status).toBe("replayed");
    // The court time is held again for it, as a tournament block.
    const held = await getDb().prepare("SELECT 1 FROM blocks WHERE tournament_id = ? AND court_id = ? AND date = ? AND start_min <= ? AND end_min >= ?").get(t.id, slot.courtId, slot.date, slot.startMin, slot.startMin + 60);
    expect(held).toBeTruthy();
    // What was played is in the record, not deleted.
    const kept = (await getDb().prepare("SELECT before_state FROM tournament_corrections WHERE tournament_id = ? AND kind = 'replay'").get(t.id)) as { before_state: string };
    expect(JSON.parse(kept.before_state)).toEqual([expect.objectContaining({ id: final.id, winner: semi.a, status: "done", score: "21-18, 21-19" })]);
    // Played again, it finishes.
    const again = await recordResult(final.id, { winner: semi.b!, score: "21-15, 21-17" });
    if (!again.ok) throw new Error(again.error);
    expect(again.value.status).toBe("finished");
  });

  it("is not replayed onto a court somebody has booked: the booking is never moved", async () => {
    const { t, final, owner, issue } = await wrongFinal();
    const review = await reviewIssue(issue.id);
    if (!review.ok) throw new Error(review.error);
    const booked = await createBooking({ courtId: final.courtId!, date: final.date!, hours: [final.minute! / 60], name: "Somebody Else", phone: "0123999111", staff: { override: true } });
    if (!booked.ok) throw new Error(booked.error);
    const done = await resolveIssue(
      issue.id,
      { action: "replay", reason: "Final replayed with the right finalist", token: review.value.token, slots: { [final.id]: { courtId: final.courtId!, date: final.date!, startMin: final.minute! } } },
      owner
    );
    expect(done).toMatchObject({ ok: false, error: expect.stringMatching(/not free/) });
    // Nothing changed: still open, the final as played.
    const d = (await tournamentDetail(t.id))!;
    expect(d.issues[0].status).toBe("open");
    expect(d.matches.find((m) => m.id === final.id)!.status).toBe("done");
  });
});

describe("how results count, by the sport's rules", () => {
  it("a retirement keeps the score as it stood, and counts it in the table only where the rules say as played", async () => {
    for (const retired of ["win_only", "as_played"] as const) {
      const t = await tournament({ format: "round_robin", rules: { scoring: { retired } } });
      await entries(t.id, 3);
      const drawn = await makeDraw(t.id, fixed);
      if (!drawn.ok) throw new Error(drawn.error);
      const m = drawn.value.matches.find((x) => x.stage === "group")!;
      // The first-named side won the first game, then stopped in the second, 3-8 down.
      const score = "21-15, 3-8";
      const r = await recordResult(m.id, { winner: m.b!, score, retired: true });
      if (!r.ok) throw new Error(r.error);
      const after = r.value.matches.find((x) => x.id === m.id)!;
      expect(after).toMatchObject({ status: "retired", winner: m.b, score: "21-15, 3-8" });
      const row = r.value.groups[0].table.find((x) => x.entryId === m.b)!;
      expect(row.won).toBe(1);
      // Never made up: one game each as played, 23 points to 24.
      expect(row.setDiff).toBe(0);
      expect(row.pointDiff).toBe(retired === "win_only" ? 0 : -1);
    }
  });

  it("a sport scored in goals allows draws in a round robin, ranks by points, and needs a winner in a knockout", async () => {
    const arena = (await listVenues()).find((v) => v.courts.some((c) => c.sport === "futsal"))!;
    const futsalCourts = arena.courts.filter((c) => c.sport === "futsal").map((c) => c.id);
    const t = await tournament({ venueId: arena.id, sport: "futsal", format: "round_robin", entryKind: "team", courtIds: futsalCourts.slice(0, 1) });
    expect(t.template).toBe("goals_league");
    expect(t.rules.scoring).toMatchObject({ kind: "tally", draws: true, tablePoints: { win: 3, draw: 1, loss: 0 } });
    const teams = [];
    for (const team of ["Red", "Blue", "Green"]) {
      const user = await player();
      const made = await enter(user, t.id, { teamName: `${team} FC`, roster: ["One Player", "Two Player", "Three Player", "Four Player", "Five Player"] });
      if (!made.ok) throw new Error(made.error);
      teams.push(made.value.id);
    }
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    expect(drawn.value.matches.every((m) => m.stage === "group")).toBe(true);
    const [first, second, third] = drawn.value.matches;
    expect(await recordResult(first.id, { winner: first.a!, score: "1-2" })).toMatchObject({ ok: false, error: "That score says the other side won." });
    expect((await recordResult(first.id, { winner: null, score: "2-2" })).ok).toBe(true);
    expect((await recordResult(second.id, { winner: second.a!, score: "3-1" })).ok).toBe(true);
    const last = await recordResult(third.id, { winner: third.b!, score: "0-1" });
    if (!last.ok) throw new Error(last.error);
    expect(last.value.status).toBe("finished");
    const table = last.value.groups[0].table;
    expect(table.reduce((sum, r) => sum + r.points, 0)).toBe(3 + 3 + 1 + 1);
    expect(table.find((r) => r.entryId === first.a)!.drawn).toBe(1);
  });
});

describe("court time", () => {
  // The hours held, "court:hour" for each hour a hold covers.
  const heldHours = async (id: number) => {
    const rows = (await getDb()
      .prepare("SELECT court_id, start_min, end_min FROM blocks WHERE tournament_id = ? ORDER BY court_id, start_min")
      .all(id)) as { court_id: number; start_min: number; end_min: number }[];
    return rows.flatMap((b) => Array.from({ length: (b.end_min - b.start_min) / 60 }, (_, i) => `${b.court_id}:${b.start_min / 60 + i}`));
  };

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
    const held = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE tournament_id = ?").get(t.id)) as { n: number };
    expect(held.n).toBe(0);
    const owed = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = 'entry-bill-1'").get()) as { due: number };
    expect(owed.due).toBe(20);
    expect((await publicTournaments()).some((x) => x.id === t.id)).toBe(false);
  });
});

describe("an entry fee paid twice", () => {
  const receipts = async (entryId: number, paymentBill: string) =>
    (await getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*)::int FROM receipts WHERE source LIKE ?) AS counter,
           (SELECT COUNT(*)::int FROM receipts r JOIN online_payments p ON r.source = 'payment:' || p.id WHERE p.bill_id = ?) AS online`
      )
      .get(`entry:${entryId}@%`, paymentBill)) as { counter: number; online: number };
  const owed = async (bill: string) =>
    (await getDb().prepare("SELECT status, amount::float AS amount, refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE bill_id = ?").get(bill)) as {
      status: string;
      amount: number;
      due: number;
      refunded: number;
    };

  it("at the counter, then online: one is the fee, the other owed back, one receipt, however often the gateway reports it", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "dup-bill-1", url: "https://www.billplz-sandbox.com/bills/dup-bill-1" })));
    const t = await tournament();
    const [first] = await entries(t.id, 1);
    // The page is open when the desk takes the fee in cash.
    expect(await startEntryPayment(first.user, t.id)).toMatchObject({ ok: true });
    expect((await setEntry(first.entryId, { paid: true })).ok).toBe(true);
    // The callback, its retry and the redirect: three reports of one payment, at the same moment.
    await Promise.all([0, 1, 2].map(() => settleBill({ billId: "dup-bill-1", paid: true, paidAt: null })));
    expect(await owed("dup-bill-1")).toEqual({ status: "paid", amount: 20, due: 20, refunded: 0 });
    // Revenue once: the counter's receipt; none for the money owed back.
    expect(await receipts(first.entryId, "dup-bill-1")).toEqual({ counter: 1, online: 0 });
    expect((await refundsOwed(venueId)).map((p) => p.billId)).toContain("dup-bill-1");

    // Refunded once, however often it is asked for.
    const pid = (await refundsOwed(venueId)).find((p) => p.billId === "dup-bill-1")!.id;
    const [a, b] = await Promise.all([markRefunded(pid, venueId), markRefunded(pid, venueId)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await owed("dup-bill-1")).toMatchObject({ due: 20, refunded: 20 });
    expect((await refundsOwed(venueId)).map((p) => p.billId)).not.toContain("dup-bill-1");
    const refunds = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM online_refunds WHERE payment_id = ?").get(pid)) as { n: number };
    expect(refunds.n).toBe(1);
  });

  it("on two pages at once: the first is the fee, the second owed back", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "two-page-1", url: "https://www.billplz-sandbox.com/bills/two-page-1" })));
    const t = await tournament();
    const [first] = await entries(t.id, 1);
    expect(await startEntryPayment(first.user, t.id)).toMatchObject({ ok: true });
    // A second page for the same entry, opened elsewhere (another tab, a day later).
    await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, tournament_entry_id)
         SELECT provider, 'two-page-2', url, venue_id, amount, payer_name, payer_phone, purpose, tournament_entry_id FROM online_payments WHERE bill_id = 'two-page-1'`
      )
      .run();
    await Promise.all([settleBill({ billId: "two-page-1", paid: true, paidAt: null }), settleBill({ billId: "two-page-2", paid: true, paidAt: null })]);
    const dues = [(await owed("two-page-1")).due, (await owed("two-page-2")).due].sort();
    expect(dues).toEqual([0, 20]);
    expect((await myEntry(first.user.id, t.id))?.paid).toBe(true);
    const online = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM receipts r JOIN online_payments p ON r.source = 'payment:' || p.id WHERE p.bill_id IN ('two-page-1', 'two-page-2')")
      .get()) as { n: number };
    expect(online.n).toBe(1);
  });

  it("paid online cannot be unmarked at the counter, and two counter marks receipt once", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "online-only-1", url: "https://www.billplz-sandbox.com/bills/online-only-1" })));
    const t = await tournament();
    const [paidOnline, atDesk] = await entries(t.id, 2);
    expect(await startEntryPayment(paidOnline.user, t.id)).toMatchObject({ ok: true });
    await settleBill({ billId: "online-only-1", paid: true, paidAt: null });
    expect((await setEntry(paidOnline.entryId, { paid: false })).ok).toBe(false);
    expect((await myEntry(paidOnline.user.id, t.id))?.paid).toBe(true);

    await Promise.all([setEntry(atDesk.entryId, { paid: true }), setEntry(atDesk.entryId, { paid: true })]);
    expect((await receipts(atDesk.entryId, "none")).counter).toBe(1);
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
