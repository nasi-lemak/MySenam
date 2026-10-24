import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { createCompetition } from "../src/lib/competitions";
import { getDb } from "../src/lib/db";
import { addOfficial, officialByToken, officialResult } from "../src/lib/match-reports";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import {
  applyCorrection,
  createTournament,
  enter,
  makeDraw,
  moveMatch,
  previewResult,
  recordResult,
  setEntry,
  takeOut,
  previewTakeOut,
  tournamentDetail,
  type Match,
  type TournamentDetail,
  type TournamentInput,
} from "../src/lib/tournaments";

/**
 * Fixtures: how long each match is given (the tournament's or division's
 * length, a stage's, one fixture's), scheduled so no court and no player has
 * two at once; fixtures moved by an organiser; the optional third-place
 * match through byes, walkovers, withdrawals and corrections; and who is
 * entered: guardians of declared minors, check-in, an organiser's
 * eligibility check, and officials' links.
 */

let venueId: number;
let courts: number[];
let ownerId: number;
let n = 0;
let dayOffset = 5;

async function player(name?: string): Promise<User> {
  n++;
  const made = await registerUser({ name: name ?? `Player ${n}`, email: `f${n}@fixtures.my`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(todayISO(), dayOffset++);
  const made = await createTournament(
    {
      venueId,
      name: `Fixture Cup ${dayOffset}`,
      sport: "badminton",
      format: "knockout",
      teamSize: 1,
      level: null,
      entryFee: 0,
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

async function entered(tournamentId: number, count: number) {
  const out: { user: User; entryId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await player();
    const made = await enter(user, tournamentId);
    if (!made.ok) throw new Error(made.error);
    out.push({ user, entryId: made.value.id });
  }
  return out;
}

const end = (m: Match) => m.minute! + m.minutes;
const overlap = (x: Match, y: Match) => x.date === y.date && x.minute! < end(y) && y.minute! < end(x);

/** No two matches on one court at once, and nobody (by entry) in two at once. */
function expectNoClashes(matches: Match[]) {
  const placed = matches.filter((m) => m.minute !== null);
  for (const x of placed)
    for (const y of placed) {
      if (x.id >= y.id || !overlap(x, y)) continue;
      expect(x.courtId, `${x.id} and ${y.id} share a court`).not.toBe(y.courtId);
      const sides = [x.a, x.b].filter((s) => s !== null);
      expect(sides.some((s) => s === y.a || s === y.b), `${x.id} and ${y.id} share a side`).toBe(false);
    }
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues()).find((v) => v.courts.filter((c) => c.sport === "badminton").length >= 2)!;
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("match lengths", () => {
  it("take the stage's length over the tournament's, and every match is placed after those feeding it end", async () => {
    const t = await tournament({ format: "groups", groupSize: 4, advance: 2, matchMinutes: 30, stageMinutes: { knockout: 45, final: 60 } });
    expect(t.stageMinutes).toEqual({ knockout: 45, final: 60 });
    await entered(t.id, 8);
    const drawn = await makeDraw(t.id, () => 0.3);
    expect(drawn.ok).toBe(true);
    const d = (await tournamentDetail(t.id))!;
    const lastRound = Math.max(...d.matches.filter((m) => m.stage === "knockout").map((m) => m.round));
    for (const m of d.matches)
      expect(m.minutes).toBe(m.stage === "group" ? 30 : m.round === lastRound ? 60 : 45);
    expectNoClashes(d.matches);
    // Every knockout match starts once every group match has ended; the final once both semi-finals have.
    const groupsEnd = Math.max(...d.matches.filter((m) => m.stage === "group").map(end));
    for (const m of d.matches.filter((x) => x.stage === "knockout" && x.round === 1)) expect(m.minute!).toBeGreaterThanOrEqual(groupsEnd);
    const final = d.matches.find((m) => m.stage === "knockout" && m.round === lastRound)!;
    for (const semi of d.matches.filter((m) => m.next === final.id)) expect(final.minute!).toBeGreaterThanOrEqual(end(semi));
  });

  it("refuses a stage length that is not 5 minutes to 10 hours, or longer than the day", async () => {
    const day = addDays(todayISO(), dayOffset++);
    const base = { venueId, name: "Bad Lengths", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 11, courtIds: courts } as TournamentInput;
    expect(await createTournament({ ...base, stageMinutes: { final: 3 } }, ownerId)).toMatchObject({ ok: false, error: expect.stringMatching(/5 minutes to 10 hours/) });
    expect(await createTournament({ ...base, stageMinutes: { final: 180 } }, ownerId)).toMatchObject({ ok: false, error: expect.stringMatching(/does not fit/) });
    expect(await createTournament({ ...base, stageMinutes: { semis: 30 } as never }, ownerId)).toMatchObject({ ok: false, error: expect.stringMatching(/No stage called semis/) });
    expect(await createTournament({ ...base, format: "round_robin", thirdPlace: true }, ownerId)).toMatchObject({ ok: false, error: expect.stringMatching(/third-place match is for a knockout/) });
  });

  it("lets a division of a competition give its matches their own length, scheduled around the other divisions' on court and by player", async () => {
    const day = addDays(todayISO(), dayOffset++);
    const c = await createCompetition({ venueId, name: "Mixed Lengths Open", sport: "badminton", startsOn: day, endsOn: day, startMin: 540, endMin: 900, matchMinutes: 30, courtIds: courts }, ownerId);
    if (!c.ok) throw new Error(c.error);
    const division = async (name: string, over: Partial<TournamentInput> = {}) => {
      const made = await createTournament(
        { venueId, competitionId: c.value.id, name, sport: "badminton", format: "round_robin", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, courtIds: [], ...over } as TournamentInput,
        ownerId
      );
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const juniors = await division("Juniors");
    const seniors = await division("Seniors", { matchMinutes: 45 });
    expect(juniors.matchMinutes).toBe(30);
    expect(seniors.matchMinutes).toBe(45);
    const both = await player("In Both");
    for (const tId of [juniors.id, seniors.id]) expect(await enter(both, tId)).toMatchObject({ ok: true });
    await entered(juniors.id, 3);
    await entered(seniors.id, 3);
    expect((await makeDraw(juniors.id, () => 0.2)).ok).toBe(true);
    expect((await makeDraw(seniors.id, () => 0.2)).ok).toBe(true);
    const j = (await tournamentDetail(juniors.id, { forStaff: true }))!;
    const s = (await tournamentDetail(seniors.id, { forStaff: true }))!;
    expect(j.matches.every((m) => m.minutes === 30)).toBe(true);
    expect(s.matches.every((m) => m.minutes === 45)).toBe(true);
    expectNoClashes(j.matches);
    expectNoClashes(s.matches);
    // Across the divisions: never two on one court at once, and the player in both never in two places.
    const userOf = (d: TournamentDetail, entryId: number | null) => d.entries.find((e) => e.id === entryId)?.userId ?? null;
    for (const x of j.matches)
      for (const y of s.matches) {
        if (!overlap(x, y)) continue;
        expect(x.courtId).not.toBe(y.courtId);
        const xs = [userOf(j, x.a), userOf(j, x.b)];
        expect(xs.includes(both.id) && [userOf(s, y.a), userOf(s, y.b)].includes(both.id)).toBe(false);
      }
  });
});

describe("moving a fixture", () => {
  it("moves it, or gives it a longer slot, held for the tournament; refused onto another match, before what feeds it, or once decided; both sides told", async () => {
    const t = await tournament({ matchMinutes: 30 });
    const players = await entered(t.id, 4);
    expect((await makeDraw(t.id, () => 0.5)).ok).toBe(true);
    let d = (await tournamentDetail(t.id))!;
    const [semi1, semi2] = d.matches.filter((m) => m.round === 1).sort((a, b) => a.position - b.position);
    const final = d.matches.find((m) => m.round === 2)!;

    // Onto the other semi-final's court and time: refused.
    expect(await moveMatch(semi1.id, { courtId: semi2.courtId!, date: semi2.date!, startMin: semi2.minute! })).toMatchObject({ ok: false, error: expect.stringMatching(/Another match of this tournament/) });
    // After the final would start: refused, the final has to come after it.
    expect(await moveMatch(semi1.id, { courtId: semi1.courtId!, date: final.date!, startMin: final.minute! })).toMatchObject({ ok: false, error: expect.stringMatching(/has to end before Final starts/) });
    // The final before the semi-finals end: refused.
    expect(await moveMatch(final.id, { courtId: final.courtId!, date: final.date!, startMin: semi1.minute! })).toMatchObject({ ok: false, error: expect.stringMatching(/has to start after Semi-final/) });

    // The final moved two hours later, then the first semi-final given 40 minutes: held, and its sides told.
    const late = final.minute! + 120;
    expect(await moveMatch(final.id, { courtId: final.courtId!, date: final.date!, startMin: late, minutes: 90 })).toMatchObject({ ok: true });
    const held = (await getDb()
      .prepare("SELECT 1 FROM blocks WHERE tournament_id = ? AND court_id = ? AND date = ? AND start_min <= ? AND end_min >= ?")
      .get(t.id, final.courtId, final.date, late, late + 90)) as unknown;
    expect(held).toBeTruthy();
    const before = await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'programme' AND subject LIKE 'Your match has moved%'").get() as { n: number };
    const moved = await moveMatch(semi1.id, { courtId: semi1.courtId!, date: semi1.date!, startMin: semi1.minute!, minutes: 40 });
    expect(moved).toMatchObject({ ok: true, value: { change: expect.stringMatching(/Semi-final 1 moved to .*–.*\(was/) } });
    d = (await tournamentDetail(t.id))!;
    expect(d.matches.find((m) => m.id === semi1.id)!.minutes).toBe(40);
    const after = await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'programme' AND subject LIKE 'Your match has moved%'").get() as { n: number };
    expect(after.n - before.n).toBe(2);
    expectNoClashes(d.matches);
    expect(d.matches.find((m) => m.id === final.id)).toMatchObject({ minute: late, minutes: 90 });

    // Decided: a result is corrected, not moved.
    expect((await recordResult(semi1.id, { winner: semi1.a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect(await moveMatch(semi1.id, { courtId: semi1.courtId!, date: semi1.date!, startMin: late })).toMatchObject({ ok: false, error: expect.stringMatching(/decided/) });
    expect(players).toHaveLength(4);
  });

  it("is a manager's: the front desk is refused, and a move is in the activity log", async () => {
    const t = await tournament({ matchMinutes: 30 });
    await entered(t.id, 2);
    expect((await makeDraw(t.id, () => 0.5)).ok).toBe(true);
    const m = (await tournamentDetail(t.id))!.matches[0];
    const { POST } = await import("../src/app/api/admin/tournaments/[id]/matches/[matchId]/route");
    const desk = await createAdmin({ email: `desk${n}@fixtures.my`, name: "Desk", password: "a long enough password", role: "desk", venueId });
    if (!desk.ok) throw new Error(desk.error);
    const as = async (adminId: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}`;
    const call = async (adminId: number) =>
      POST(
        new NextRequest(`http://localhost/api/admin/tournaments/${t.id}/matches/${m.id}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: await as(adminId), origin: "http://localhost" },
          body: JSON.stringify({ move: { courtId: m.courtId, date: m.date, startMin: m.minute! + 60 } }),
        }),
        { params: Promise.resolve({ id: String(t.id), matchId: String(m.id) }) }
      );
    expect((await call(desk.admin.id)).status).toBe(403);
    expect((await call(ownerId)).status).toBe(200);
    expect(await getDb().prepare("SELECT 1 FROM staff_actions WHERE action = 'tournament.match_moved' AND detail LIKE ?").get(`${t.name}:%`)).toBeTruthy();
  });
});

describe("a third-place match", () => {
  async function four(over: Partial<TournamentInput> = {}) {
    const t = await tournament({ thirdPlace: true, matchMinutes: 30, ...over });
    const players = await entered(t.id, 4);
    expect((await makeDraw(t.id, () => 0.5)).ok).toBe(true);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    const semis = d.matches.filter((m) => m.round === 1).sort((a, b) => a.position - b.position);
    const final = d.matches.find((m) => m.round === 2 && m.placement === null)!;
    const third = d.matches.find((m) => m.placement === 3)!;
    return { t, players, semis, final, third };
  }

  it("is played by the semi-finals' losers, scheduled after both, and the tournament finishes only once it is played", async () => {
    const { t, semis, final, third } = await four();
    expect(third).toMatchObject({ round: 2, stage: "knockout", a: null, b: null, status: "scheduled" });
    expect(semis.map((s) => [s.loserNext, s.loserNextSlot])).toEqual([[third.id, "a"], [third.id, "b"]]);
    for (const s of semis) expect(third.minute!).toBeGreaterThanOrEqual(end(s));
    expect((await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" })).ok).toBe(true);
    // Scores are written side A first.
    expect((await recordResult(semis[1].id, { winner: semis[1].b!, score: "10-21, 12-21" })).ok).toBe(true);
    let d = (await tournamentDetail(t.id))!;
    expect(d.matches.find((m) => m.id === third.id)).toMatchObject({ a: semis[0].b, b: semis[1].a });
    expect(d.matches.find((m) => m.id === final.id)).toMatchObject({ a: semis[0].a, b: semis[1].b });
    expect((await recordResult(final.id, { winner: semis[0].a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await tournamentDetail(t.id))!.status).toBe("drawn");
    expect((await recordResult(third.id, { winner: semis[1].a!, score: "19-21, 19-21" })).ok).toBe(true);
    d = (await tournamentDetail(t.id))!;
    expect(d.status).toBe("finished");
    expect(d.matches.find((m) => m.id === third.id)).toMatchObject({ winner: semis[1].a, status: "done" });
  });

  it("is a walkover when a semi-final was lost by withdrawal, and nobody plays it when both losers are out", async () => {
    const { t, semis, third } = await four();
    // Somebody leaves before their semi-final: they lose it by walkover, and are out of the third-place match too.
    const leaving = semis[0].b!;
    const preview = await previewTakeOut(leaving, "withdrawn");
    if (!preview.ok) throw new Error(preview.error);
    expect((await takeOut(leaving, "withdrawn", undefined, { token: preview.value.token })).ok).toBe(true);
    let d = (await tournamentDetail(t.id))!;
    expect(d.matches.find((m) => m.id === semis[0].id)).toMatchObject({ status: "walkover", winner: semis[0].a });
    expect((await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" })).ok).toBe(true);
    d = (await tournamentDetail(t.id))!;
    expect(d.matches.find((m) => m.id === third.id)).toMatchObject({ status: "walkover", winner: semis[1].b });
  });

  it("is not made with fewer than four in the draw", async () => {
    const t = await tournament({ thirdPlace: true });
    await entered(t.id, 3);
    expect((await makeDraw(t.id, () => 0.5)).ok).toBe(true);
    expect((await tournamentDetail(t.id))!.matches.some((m) => m.placement === 3)).toBe(false);
  });

  it("keeps a played third-place match when a semi-final is corrected after it: refused as a plain result, and a record-only correction opens an issue that blocks finishing", async () => {
    const { t, semis, final, third } = await four();
    expect((await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" })).ok).toBe(true);
    const thirdPlayed = await recordResult(third.id, { winner: semis[0].b!, score: "21-15, 21-15" });
    expect(thirdPlayed.ok).toBe(true);
    // The first semi-final's result reversed: who played the third-place match would be wrong.
    const reversed = { winner: semis[0].b!, score: "10-21, 12-21" };
    expect(await recordResult(semis[0].id, reversed)).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    const preview = await previewResult(semis[0].id, reversed);
    if (!preview.ok) throw new Error(preview.error);
    const corrected = await applyCorrection(semis[0].id, reversed, { mode: "standings_only", reason: "Scorer swapped the names", token: preview.value.token }, { id: ownerId, name: "Owner" });
    expect(corrected.ok).toBe(true);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    // The played match stands as played; the wrong advancement is an open issue.
    expect(d.matches.find((m) => m.id === third.id)).toMatchObject({ status: "done", winner: semis[0].b });
    expect(d.issues.filter((i) => i.status === "open").map((i) => i.fromMatchId)).toEqual(expect.arrayContaining([third.id]));
    expect((await recordResult(final.id, { winner: d.matches.find((m) => m.id === final.id)!.a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await tournamentDetail(t.id))!.status).toBe("drawn");
  });
});

describe("who is entered", () => {
  it("asks a declared minor for a parent or guardian's agreement, kept for staff only and never presented as verified", async () => {
    const t = await tournament({ ageMin: 10, ageMax: 17 });
    const kid = await player("Young Player");
    const birth = `${Number(t.startsOn.slice(0, 4)) - 12}-01-15`;
    expect(await enter(kid, t.id, { birthDate: birth })).toMatchObject({ ok: false, code: "GUARDIAN_CONSENT" });
    expect(await enter(kid, t.id, { birthDate: birth, guardianName: "Parent", guardianConsent: false })).toMatchObject({ ok: false, code: "GUARDIAN_CONSENT" });
    const made = await enter(kid, t.id, { birthDate: birth, guardianName: "Aminah Parent", guardianConsent: true });
    expect(made.ok).toBe(true);
    const staff = (await tournamentDetail(t.id, { forStaff: true }))!.entries[0];
    expect(staff).toMatchObject({ guardian: { name: "Aminah Parent", consentAt: expect.any(String) }, declaredBirthDate: birth, eligibilityChecked: null });
    const pub = (await tournamentDetail(t.id))!.entries[0];
    expect(pub.guardian).toBeUndefined();
    expect(pub.declaredBirthDate).toBeUndefined();

    // An adult in an open-age event is not asked.
    const open = await tournament({ ageMin: 16 });
    const adult = await player();
    expect(await enter(adult, open.id, { birthDate: `${Number(open.startsOn.slice(0, 4)) - 30}-01-15` })).toMatchObject({ ok: true });
  });

  it("marks arrivals and an organiser's own eligibility check: who checked and when, nothing of the document", async () => {
    const t = await tournament();
    const [{ entryId }] = await entered(t.id, 1);
    expect(await setEntry(entryId, { checkedIn: true })).toMatchObject({ ok: true, value: { checkedIn: true } });
    expect(await setEntry(entryId, { eligibilityCheckedBy: "Desk Manager" })).toMatchObject({ ok: true });
    let e = (await tournamentDetail(t.id, { forStaff: true }))!.entries[0];
    expect(e).toMatchObject({ checkedIn: true, eligibilityChecked: { by: "Desk Manager", at: expect.any(String) } });
    expect(await setEntry(entryId, { checkedIn: false, eligibilityCheckedBy: null })).toMatchObject({ ok: true });
    e = (await tournamentDetail(t.id, { forStaff: true }))!.entries[0];
    expect(e).toMatchObject({ checkedIn: false, eligibilityChecked: null });
  });

  it("passes the organiser's choice of who enters results through the admin route (it was dropped before)", async () => {
    const { POST } = await import("../src/app/api/admin/tournaments/route");
    const day = addDays(todayISO(), dayOffset++);
    const res = await POST(
      new NextRequest("http://localhost/api/admin/tournaments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`, origin: "http://localhost" },
        body: JSON.stringify({ venueId, name: "Players Report Cup", sport: "badminton", format: "knockout", teamSize: 1, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 12, courtIds: courts, resultsBy: "players", thirdPlace: true, stageMinutes: { final: 45 } }),
      })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).tournament).toMatchObject({ resultsBy: "players", thirdPlace: true, stageMinutes: { final: 45 } });
  });
});

describe("officials' links", () => {
  it("work until their last day and only for matches still to be decided", async () => {
    const t = await tournament();
    await entered(t.id, 4);
    expect((await makeDraw(t.id, () => 0.5)).ok).toBe(true);
    expect(await addOfficial(t.id, "Referee", ownerId, addDays(t.endsOn, 1))).toMatchObject({ ok: false, error: expect.stringMatching(/until .* at the latest/) });
    const made = await addOfficial(t.id, "Referee", ownerId);
    if (!made.ok) throw new Error(made.error);
    expect(made.value.official.expiresOn).toBe(t.endsOn);
    const m = (await tournamentDetail(t.id))!.matches.find((x) => x.round === 1)!;
    expect(await officialResult(made.value.token, m.id, { winner: m.a!, score: "21-10, 21-12" })).toMatchObject({ ok: true });
    // Already decided: a correction is the organiser's.
    expect(await officialResult(made.value.token, m.id, { winner: m.b!, score: "21-10, 21-12" })).toMatchObject({ ok: false, error: expect.stringMatching(/ask the organiser/) });
    // Past its last day it no longer works.
    await getDb().prepare("UPDATE tournament_officials SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), -1), made.value.official.id);
    expect(await officialByToken(made.value.token)).toBeNull();
  });
});
