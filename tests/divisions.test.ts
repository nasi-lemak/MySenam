import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { standings } from "../src/lib/brackets";
import { cancelCompetition, competitionDetail, createCompetition } from "../src/lib/competitions";
import { templateByKey } from "../src/lib/competition-templates";
import { getDb } from "../src/lib/db";
import { createBookingSeries, listVenues, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { parseRules } from "../src/lib/tournament-rules";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { ageOn, cancelTournament, closeDueEntries, createTournament, enter, makeDraw, tournamentDetail, type TournamentInput } from "../src/lib/tournaments";

/**
 * Competitions with divisions: one event holds the courts once, and each
 * division is a tournament of its own scheduled into that time without two
 * matches on one court or one player in two places; who may enter (closing
 * day, ages, members, divisions per player); and table points that depend
 * on the set score (ADR 0013).
 */

let ownerId: number;
let venueId: number;
let courtIds: number[];
let n = 0;
let dayOffset = 4;

async function player(name = `Player ${n + 1}`): Promise<User> {
  n++;
  const made = await registerUser({ name, email: `d${n}@div.my`, phone: `01360${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

const nextDay = () => addDays(todayISO(), dayOffset++);

async function event(over: Partial<Parameters<typeof createCompetition>[0]> = {}) {
  const day = nextDay();
  const made = await createCompetition(
    { venueId, name: `Club Championship ${dayOffset}`, sport: "badminton", startsOn: day, endsOn: day, startMin: 9 * 60, endMin: 13 * 60, matchMinutes: 30, courtIds, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function division(competitionId: number, over: Partial<TournamentInput> = {}) {
  const made = await createTournament(
    {
      venueId,
      competitionId,
      name: `Division ${++n}`,
      sport: "badminton",
      format: "round_robin",
      teamSize: 1,
      level: null,
      entryFee: 0,
      maxEntries: 16,
      // Ignored for a division: the competition's.
      startsOn: "2099-01-01",
      endsOn: "2099-01-01",
      courtIds: [],
      ...over,
    } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const blocksOf = async (where: string, id: number) =>
  ((await getDb().prepare(`SELECT court_id, date, start_min, end_min FROM blocks WHERE ${where} = ? ORDER BY court_id, start_min`).all(id)) as {
    court_id: number;
    start_min: number;
    end_min: number;
  }[]);

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues()).find((v) => v.courts.filter((c) => c.sport === "badminton").length >= 2)!;
  venueId = venue.id;
  courtIds = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("a competition", () => {
  it("holds its courts once, refused over a booking; its divisions take its days, hours and courts and hold nothing of their own", async () => {
    // A booking in the way is refused, as for a tournament on its own.
    const day = nextDay();
    const booked = await createBookingSeries({ courtId: courtIds[0], date: day, hours: [10], name: "Booker", phone: "0137000001", weeks: 1 });
    expect(booked.ok).toBe(true);
    expect(await createCompetition({ venueId, name: "Clashing Open", sport: "badminton", startsOn: day, endsOn: day, startMin: 540, endMin: 780, matchMinutes: 30, courtIds }, ownerId)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/booking is already in those hours/),
    });

    const c = await event();
    expect(await blocksOf("competition_id", c.id)).toEqual(courtIds.map((id) => expect.objectContaining({ court_id: id, start_min: 540, end_min: 780 })));
    const singles = await division(c.id, { name: "Men's Singles" });
    expect(singles).toMatchObject({ competition: { id: c.id, name: c.name }, startsOn: c.startsOn, startMin: 540, endMin: 780, matchMinutes: 30, courtIds });
    expect(await blocksOf("tournament_id", singles.id)).toEqual([]);
    expect((await competitionDetail(c.id))?.divisions.map((d) => d.name)).toEqual(["Men's Singles"]);
    // Not at another venue; not for a competition called off.
    const other = (await listVenues()).find((v) => v.id !== venueId)!;
    expect(await createTournament({ ...singles, venueId: other.id, competitionId: c.id, name: "Elsewhere", rules: undefined } as unknown as TournamentInput, ownerId)).toMatchObject({ ok: false, error: expect.stringMatching(/another venue/) });
  });

  it("schedules each division around the others: never two matches on one court, never one player in two places, and gives back time only once every draw is made", async () => {
    const c = await event();
    const singles = await division(c.id, { name: "Singles" });
    const veterans = await division(c.id, { name: "Veterans" });
    const both = await player("Both Divisions");
    const singlesOnly = await Promise.all([1, 2, 3].map(() => player()));
    const veteransOnly = await Promise.all([1, 2, 3].map(() => player()));
    for (const p of [both, ...singlesOnly]) expect(await enter(p, singles.id)).toMatchObject({ ok: true });
    for (const p of [both, ...veteransOnly]) expect(await enter(p, veterans.id)).toMatchObject({ ok: true });

    expect(await makeDraw(singles.id, () => 0.3)).toMatchObject({ ok: true });
    // One division drawn, the other not: nothing given back yet.
    expect(await blocksOf("competition_id", c.id)).toEqual(courtIds.map((id) => expect.objectContaining({ court_id: id, start_min: 540, end_min: 780 })));
    // No division may be added once a draw is made.
    expect(await createTournament({ venueId, competitionId: c.id, name: "Late Division", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: c.startsOn, endsOn: c.endsOn, courtIds: [] }, ownerId)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/before any draw/),
    });
    expect(await makeDraw(veterans.id, () => 0.6)).toMatchObject({ ok: true });

    const all = [...(await tournamentDetail(singles.id))!.matches, ...(await tournamentDetail(veterans.id))!.matches];
    expect(all.length).toBe(12);
    const at = (m: (typeof all)[number]) => `${m.date} ${m.minute}`;
    // One match per court at a time across both divisions.
    const courtTimes = all.map((m) => `${m.courtId} ${at(m)}`);
    expect(new Set(courtTimes).size).toBe(courtTimes.length);
    // The player in both divisions is never in two matches at once.
    const singlesEntry = (await tournamentDetail(singles.id, { forStaff: true }))!.entries.find((e) => e.userId === both.id)!.id;
    const veteransEntry = (await tournamentDetail(veterans.id, { forStaff: true }))!.entries.find((e) => e.userId === both.id)!.id;
    const theirs = all.filter((m) => [m.a, m.b].includes(singlesEntry) || [m.a, m.b].includes(veteransEntry)).map(at);
    expect(theirs).toHaveLength(6);
    expect(new Set(theirs).size).toBe(6);
    // Both drawn: what no match uses goes back; what any match uses stays held.
    const held = await blocksOf("competition_id", c.id);
    for (const m of all) expect(held.some((b) => b.court_id === m.courtId && b.start_min <= m.minute! && m.minute! + 30 <= b.end_min)).toBe(true);
    const last = Math.max(...all.map((m) => m.minute!)) + 30;
    expect(held.every((b) => b.end_min <= last)).toBe(true);
  });

  it("puts a player in two divisions on court in the second only once the first match is over, even with a court free", async () => {
    const c = await event();
    const [first, second] = [await division(c.id, { format: "knockout" }), await division(c.id, { format: "knockout" })];
    const both = await player();
    for (const p of [both, await player()]) expect(await enter(p, first.id)).toMatchObject({ ok: true });
    for (const p of [both, await player()]) expect(await enter(p, second.id)).toMatchObject({ ok: true });
    expect(await makeDraw(first.id)).toMatchObject({ ok: true });
    expect(await makeDraw(second.id)).toMatchObject({ ok: true });
    const [m1] = (await tournamentDetail(first.id))!.matches;
    const [m2] = (await tournamentDetail(second.id))!.matches;
    // The other court was free at 9:00; the player was not.
    expect([m1.minute, m2.minute]).toEqual([540, 570]);
  });

  it("called off, calls off every division and gives its courts back", async () => {
    const c = await event();
    const d1 = await division(c.id);
    const d2 = await division(c.id);
    // One division called off on its own: the other still needs the time.
    expect(await cancelTournament(d1.id)).toMatchObject({ ok: true });
    expect(await blocksOf("competition_id", c.id)).toHaveLength(2);
    expect(await cancelCompetition(c.id)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect((await tournamentDetail(d2.id))?.status).toBe("cancelled");
    expect(await blocksOf("competition_id", c.id)).toEqual([]);
    expect(await cancelCompetition(c.id)).toMatchObject({ ok: false });
  });
});

describe("who may enter", () => {
  it("entries close after their last day, refused then and closed by the scheduler", async () => {
    const c = await event();
    const d = await division(c.id, { entriesCloseOn: addDays(c.startsOn, -1) });
    expect(d.entriesCloseOn).toBe(addDays(c.startsOn, -1));
    expect(await createTournament({ ...d, venueId, competitionId: c.id, name: "Too Late", entriesCloseOn: c.startsOn, rules: undefined } as unknown as TournamentInput, ownerId)).toMatchObject({
      ok: false,
      error: "Entries must close before the first day.",
    });
    expect(await enter(await player(), d.id)).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE tournaments SET entries_close_on = ? WHERE id = ?").run(addDays(todayISO(), -1), d.id);
    expect(await enter(await player(), d.id)).toMatchObject({ ok: false, error: expect.stringMatching(/^Entries closed on/) });
    expect(await closeDueEntries()).toBeGreaterThanOrEqual(1);
    expect((await tournamentDetail(d.id))?.status).toBe("closed");
  });

  it("an age range is checked on the first day against the dates of birth declared, a partner's too, and a captain declares the roster", async () => {
    const c = await event();
    const juniors = await division(c.id, { name: "Under 12", ageMax: 11 });
    expect(juniors.ageRange).toEqual({ min: null, max: 11 });
    const first = c.startsOn;
    const born = (years: number, daysAfter = 0) => addDays(`${Number(first.slice(0, 4)) - years}${first.slice(4)}`, daysAfter);
    expect(ageOn(born(12), first)).toBe(12);
    expect(ageOn(born(12, 1), first)).toBe(11);
    expect(await enter(await player(), juniors.id)).toMatchObject({ ok: false, code: "AGE_RANGE", error: expect.stringMatching(/date of birth is needed/) });
    expect(await enter(await player(), juniors.id, { birthDate: born(12) })).toMatchObject({ ok: false, error: expect.stringMatching(/You are 12 on .*ages 11 and under/) });
    // Under 18: a parent or guardian's agreement as well (lib/tournaments.ts, GUARDIAN_AGE).
    const guardian = { guardianName: "A Parent", guardianConsent: true };
    const ok = await enter(await player(), juniors.id, { birthDate: born(12, 1), ...guardian });
    expect(ok).toMatchObject({ ok: true });
    expect(((await getDb().prepare("SELECT birth_date FROM tournament_entries WHERE id = ?").get(ok.ok ? ok.value.id : 0)) as { birth_date: string }).birth_date).toBe(born(12, 1));

    const pairs = await division(c.id, { name: "Under 16 Doubles", teamSize: 2, ageMin: 10, ageMax: 15 });
    expect(await enter(await player(), pairs.id, { partnerName: "Mei", birthDate: born(14) })).toMatchObject({ ok: false, error: expect.stringMatching(/Your partner's date of birth/) });
    expect(await enter(await player(), pairs.id, { partnerName: "Mei", birthDate: born(14), partnerBirthDate: born(9) })).toMatchObject({ ok: false, error: expect.stringMatching(/Your partner is 9/) });
    expect(await enter(await player(), pairs.id, { partnerName: "Mei", birthDate: born(14), partnerBirthDate: born(13), ...guardian })).toMatchObject({ ok: true });

    // A declared date of birth is the entrant's data: in their export, gone when they are erased.
    const entrant = ok.ok ? ok.value.userId! : 0;
    expect((await exportCustomerData(entrant))?.tournaments).toEqual([expect.objectContaining({ declared_birth_date: born(12, 1), guardian_name: "A Parent" })]);
    expect(await eraseCustomer(entrant)).toMatchObject({ ok: true });
    expect((await getDb().prepare("SELECT birth_date, guardian_name FROM tournament_entries WHERE id = ?").get(ok.ok ? ok.value.id : 0)) as object).toEqual({ birth_date: null, guardian_name: null });

    const teams = await division(c.id, { name: "Junior Teams", entryKind: "team", roster: { min: 2, max: 6 }, ageMax: 15 });
    const captain = await player();
    expect(await enter(captain, teams.id, { teamName: "Shuttle Kids", roster: ["Ali", "Bea"], birthDate: born(14) })).toMatchObject({ ok: false, error: expect.stringMatching(/Confirm that everybody on the roster/) });
    expect(await enter(captain, teams.id, { teamName: "Shuttle Kids", roster: ["Ali", "Bea"], birthDate: born(14), rosterEligible: true })).toMatchObject({ ok: false, code: "GUARDIAN_CONSENT" });
    expect(await enter(captain, teams.id, { teamName: "Shuttle Kids", roster: ["Ali", "Bea"], birthDate: born(14), rosterEligible: true, ...guardian })).toMatchObject({ ok: true });
  });

  it("members only takes an active membership at the venue", async () => {
    const c = await event();
    const d = await division(c.id, { name: "Members' Plate", membersOnly: true });
    expect(d.membersOnly).toBe(true);
    const p = await player();
    expect(await enter(p, d.id)).toMatchObject({ ok: false, code: "ENTRY_MEMBERS_ONLY" });
    await sellMembership({ venueId, holderName: p.name, holderPhone: p.phone, startsOn: todayISO(), expiresOn: addDays(todayISO(), 60), price: 50, adminId: ownerId });
    expect(await enter(p, d.id)).toMatchObject({ ok: true });
  });

  it("a competition can cap how many of its divisions one player enters", async () => {
    const c = await event({ maxDivisionsPerPlayer: 2 });
    const [a, b, third] = [await division(c.id), await division(c.id), await division(c.id)];
    const p = await player();
    expect(await enter(p, a.id)).toMatchObject({ ok: true });
    expect(await enter(p, b.id)).toMatchObject({ ok: true });
    expect(await enter(p, third.id)).toMatchObject({ ok: false, code: "DIVISION_LIMIT", error: expect.stringMatching(/may enter 2 divisions/) });
    expect(await createCompetition({ venueId, name: "Bad Cap", sport: "badminton", startsOn: nextDay(), endsOn: nextDay(), startMin: 540, endMin: 600, courtIds, maxDivisionsPerPlayer: 0 }, ownerId)).toMatchObject({ ok: false });
  });
});

describe("table points by set score (volleyball's 3-2-1-0)", () => {
  const rules = templateByKey("volleyball_points")!.rules.scoring;

  it("award a clear win 3, a win in the deciding set 2, a loss in it 1, a clear loss 0; a walkover or retirement counts as clear", () => {
    expect(rules).toMatchObject({ kind: "sets", bestOf: 5, setPoints: { winClear: 3, winDecider: 2, loseDecider: 1, loseClear: 0 } });
    const table = standings(
      [1, 2, 3, 4],
      [
        { a: 1, b: 2, winner: 1, score: "25-20, 25-18, 25-22" },
        { a: 3, b: 4, winner: 3, score: "25-20, 20-25, 25-23, 23-25, 15-12" },
        { a: 1, b: 3, winner: 3, score: "25-20, 20-25, 25-23, 23-25, 13-15" },
        { a: 2, b: 4, winner: 2, score: null },
        { a: 1, b: 4, winner: 1, score: "25-10, 12-8", retired: true },
        { a: 2, b: 3, winner: 3, score: "25-20, 20-25, 25-23, 25-20" },
      ],
      rules
    );
    // 1: 3 + 1 + 3 = 7; 3: 2 + 2 + 3 = 7 (more wins, ahead); 2: 0 + 3 + 0 = 3; 4: 1 + 0 + 0 = 1.
    expect(table.map((s) => [s.entryId, s.points, s.won])).toEqual([
      [3, 7, 3],
      [1, 7, 2],
      [2, 3, 1],
      [4, 1, 0],
    ]);
    // Without points by set score, every win is worth the same.
    expect(standings([1, 2], [{ a: 1, b: 2, winner: 1, score: "25-20, 20-25, 25-23, 23-25, 15-12" }], { ...rules, setPoints: null, tablePoints: { win: 3, draw: 0, loss: 0 } })[0].points).toBe(3);
  });

  it("are four whole numbers, for matches in sets only", () => {
    expect(parseRules({ scoring: { setPoints: { winClear: 3, winDecider: 2, loseDecider: 1, loseClear: 0 } } })).toMatchObject({ ok: true, rules: { scoring: { setPoints: { winDecider: 2 } } } });
    expect(parseRules({ scoring: { setPoints: { winClear: 3, winDecider: 2, loseDecider: 1 } } })).toMatchObject({ ok: false });
    expect(parseRules({ scoring: { kind: "tally", setPoints: { winClear: 3, winDecider: 2, loseDecider: 1, loseClear: 0 } } })).toMatchObject({ ok: false, error: expect.stringMatching(/scored in sets/) });
    expect(parseRules({ scoring: { setPoints: null } }, templateByKey("volleyball_points")!.rules)).toMatchObject({ ok: true, rules: { scoring: { setPoints: null } } });
  });
});
