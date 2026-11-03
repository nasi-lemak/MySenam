import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { registerUser, SESSION_COOKIE, createSession, type User } from "../src/lib/auth";
import type { Entrant } from "../src/lib/competition-entrants";
import { guardianEntrant } from "../src/lib/competition-entrants";
import { getDb } from "../src/lib/db";
import { createLeague, decideResult, join, leagueDetail, startSeason } from "../src/lib/leagues";
import { addManaged } from "../src/lib/managed-people";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { saveProfile } from "../src/lib/player-profiles";
import { DEFAULT_RATING_RULES, orderKey, replay, type RatingFormat, type ReplayRow } from "../src/lib/rating-math";
import {
  applySeedProposal,
  boardChoices,
  businessBoard,
  eventVenue,
  excludeResult,
  liftExclusion,
  myRatings,
  poolStandings,
  proposeSeeds,
  ratedAfter,
  ratingHistory,
  ratingsCatchUp,
  recomputePool,
  resetSubject,
  setBusinessBoard,
  setEventRated,
  staffRatings,
  syncRatedEvent,
  venueBoard,
  mayViewSubject,
} from "../src/lib/ratings";
import { STAFF_ACTIONS, managerOnly } from "../src/lib/roles";
import { createCourt, listVenues } from "../src/lib/store";
import { acceptInvitation, createInviteLink, createTeam, teamView } from "../src/lib/teams";
import { createTeamLeague, decideFixture, enterTeam, generateFixtures, setLineup, teamLeagueDetail } from "../src/lib/team-leagues";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, enterAs, makeDraw, recordResult, takeOut, tournamentDetail, previewResult, applyCorrection, setEntry, type TournamentInput } from "../src/lib/tournaments";
import * as adminRatings from "../src/app/api/admin/ratings/route";
import * as publicRankings from "../src/app/api/venues/[id]/rankings/route";
import * as myRatingsRoute from "../src/app/api/my/ratings/route";

/**
 * Ratings built from results (lib/ratings.ts, lib/rating-math.ts; migration 0270, ADR 0031): the ledger of rated results, the
 * pools replayed from it, and what each reader may see of them.
 */

let ownerId: number;
let venueId: number;
let courts: number[];
let managerCookie: string;
let deskCookie: string;
let n = 0;
let dayOffset = 3;
const today = todayISO();
const R = DEFAULT_RATING_RULES;
const fixed = () => 0.42;

async function adult(name = "Player", profile: Record<string, unknown> = { adult: true }): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `rt${n}@ratings.test`, phone: `01360${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (profile) {
    const saved = await saveProfile(made.user.id, profile);
    if (!saved.ok) throw new Error(saved.error);
  }
  return made.user;
}

async function tournament(over: Partial<TournamentInput> = {}, rated = true, days = 1) {
  const day = addDays(today, dayOffset);
  dayOffset += days;
  const made = await createTournament(
    { venueId, name: `Rated Cup ${dayOffset}`, sport: "badminton", format: "round_robin", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: addDays(day, days - 1), startHour: 9, endHour: 21, courtIds: courts, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  if (rated) {
    const done = await setEventRated("tournament", made.value.id, true);
    if (!done.ok) throw new Error(done.error);
  }
  return made.value;
}

async function entered(tournamentId: number, users: User[]) {
  const out: number[] = [];
  for (const u of users) {
    const made = await enter(u, tournamentId);
    if (!made.ok) throw new Error(made.error);
    out.push(made.value.id);
  }
  return out;
}

async function drawn(tournamentId: number) {
  const d = await makeDraw(tournamentId, fixed);
  if (!d.ok) throw new Error(d.error);
  return d.value;
}

/** Record a decided match, the winner named by entry id; the score is written from the first side's view, as the sport's form is. */
async function result(matchId: number, winner: number, score?: string) {
  const m = (await getDb().prepare("SELECT entry_a FROM tournament_matches WHERE id = ?").get(matchId)) as { entry_a: number };
  const r = await recordResult(matchId, { winner, score: score ?? (winner === m.entry_a ? "21-10, 21-12" : "10-21, 12-21") });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Play every match that can be played now, the first side named winning. */
async function playOut(tournamentId: number) {
  for (let guard = 0; guard < 80; guard++) {
    const d = (await tournamentDetail(tournamentId))!;
    const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null && m.winner === null);
    if (!next) return d;
    await result(next.id, next.a!);
  }
  throw new Error("never finished");
}

/** The pool read back from the ledger the way the replay is meant to be: independent of lib/ratings.ts's own query. */
async function scratch(vId: number, sport: string, format: RatingFormat) {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.played_on, r.play_order, r.source_kind, r.source_id, r.source_match, r.unit_no, r.outcome, r.kind, r.margin FROM rated_results r
        WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM rating_exclusions x WHERE x.lifted_at IS NULL AND x.source_kind = r.source_kind AND x.source_id = r.source_id AND x.source_match = r.source_match AND x.unit_no = r.unit_no)`
    )
    .all(vId, sport, format)) as { id: number; played_on: string; play_order: number; source_kind: string; source_id: number; source_match: number; unit_no: number; outcome: string; kind: "played" | "walkover" | "retired"; margin: number | null }[];
  const subs = (await db
    .prepare(
      `SELECT s.id, s.result_id, s.side, s.subject_kind, s.subject_id, s.frozen_rating FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
        WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL`
    )
    .all(vId, sport, format)) as { id: number; result_id: number; side: "a" | "b"; subject_kind: string; subject_id: number | null; frozen_rating: string | null }[];
  const replayRows: ReplayRow[] = rows.map((r) => {
    const side = (s: "a" | "b") =>
      subs
        .filter((x) => x.result_id === r.id && x.side === s)
        .map((x) => (x.subject_kind === "removed" ? { key: `removed:${x.id}`, frozen: Number(x.frozen_rating) } : { key: `${x.subject_kind}:${x.subject_id}` }));
    return {
      id: r.id,
      order: orderKey({ playedOn: r.played_on, playOrder: r.play_order, sourceKind: r.source_kind, sourceId: r.source_id, sourceMatch: r.source_match, unitNo: r.unit_no }),
      outcome: Number(r.outcome),
      kind: r.kind,
      margin: r.margin,
      a: side("a"),
      b: side("b"),
    };
  });
  const resets = new Map<string, string>();
  for (const x of (await db.prepare("SELECT subject_kind, subject_id, cutoff_key FROM rating_resets WHERE venue_id = ? AND sport = ? AND format = ? ORDER BY id").all(vId, sport, format)) as { subject_kind: string; subject_id: number; cutoff_key: string }[])
    resets.set(`${x.subject_kind}:${x.subject_id}`, x.cutoff_key);
  return replay(replayRows, R, resets);
}

/** What the pool table says each subject stands at. */
async function stored(vId: number, sport: string, format: RatingFormat) {
  const rows = (await getDb()
    .prepare("SELECT subject_kind, subject_id, rating, games, wins, draws, losses FROM rating_subjects WHERE venue_id = ? AND sport = ? AND format = ?")
    .all(vId, sport, format)) as { subject_kind: string; subject_id: number; rating: string; games: number; wins: number; draws: number; losses: number }[];
  return new Map(rows.map((r) => [`${r.subject_kind}:${r.subject_id}`, { rating: Number(r.rating), games: r.games, wins: r.wins, draws: r.draws, losses: r.losses }]));
}

/** The stored ratings are exactly what a fresh replay of the live ledger gives. */
async function expectReplay(vId: number, sport: string, format: RatingFormat) {
  const fresh = await scratch(vId, sport, format);
  const have = await stored(vId, sport, format);
  const want = new Map([...fresh.subjects].filter(([k, s]) => !k.startsWith("removed:") && s.games > 0).map(([k, s]) => [k, { rating: s.rating, games: s.games, wins: s.wins, draws: s.draws, losses: s.losses }]));
  expect([...have].sort()).toEqual([...want].sort());
}

const live = async (kind: string, id: number) =>
  (await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = ? AND source_id = ? AND voided_at IS NULL").get(kind, id)) as { n: number };
const total = async (kind: string, id: number) =>
  (await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = ? AND source_id = ?").get(kind, id)) as { n: number };
const ratingOf = async (userId: number, format: RatingFormat = "singles") =>
  ((await getDb().prepare("SELECT rating FROM rating_subjects WHERE subject_kind = 'user' AND subject_id = ? AND format = ? AND venue_id = ?").get(userId, format, venueId)) as { rating: string } | undefined)?.rating;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  while (courts.length < 2) {
    const c = await createCourt({ venueId, name: `Rating Court ${courts.length}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
  const manager = await createAdmin({ name: "Mira Manager", email: "mira-rt@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dev Desk", email: "dev-rt@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

describe("only events a venue marks as rated count", () => {
  it("leaves an event not marked alone: results are recorded and nothing enters the ledger", async () => {
    const t = await tournament({}, false);
    const users = [await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    await playOut(t.id);
    expect(await total("tournament", t.id)).toEqual({ n: 0 });
    expect(await ratingOf(users[0].id)).toBeUndefined();
  });

  it("takes an event marked as rated before it starts: each decided match is one ledger row, and ratings follow", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    await playOut(t.id);
    expect(await live("tournament", t.id)).toEqual({ n: 6 });
    const rows = (await getDb().prepare("SELECT format, kind, outcome, sport, venue_id, event_name FROM rated_results WHERE source_kind = 'tournament' AND source_id = ?").all(t.id)) as { format: string; kind: string; outcome: string; sport: string; venue_id: number; event_name: string }[];
    expect(rows.every((r) => r.format === "singles" && r.kind === "played" && r.sport === "badminton" && r.venue_id === venueId && r.event_name === t.name)).toBe(true);
    await expectReplay(venueId, "badminton", "singles");
    // Everyone has played three matches: provisional, so not ranked yet.
    const standings = await poolStandings(venueId, "badminton", "singles");
    const mine = standings.filter((s) => users.some((u) => s.kind === "user" && s.id === u.id));
    expect(mine).toHaveLength(4);
    expect(mine.every((s) => s.provisional && s.games === 3)).toBe(true);
    // Whoever won all three is the highest.
    const best = [...mine].sort((a, b) => b.rating - a.rating)[0];
    expect(best.wins).toBe(3);
  });

  it("is chosen before the event starts: after the draw it is refused, and an event can be unmarked before", async () => {
    const t = await tournament({}, false);
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: true });
    expect(await setEventRated("tournament", t.id, false)).toMatchObject({ ok: true });
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: true });
    const users = [await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    expect(await setEventRated("tournament", t.id, false)).toMatchObject({ ok: false, code: "RT_STARTED" });
    // Saying what it already is changes nothing and is not refused.
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: true });
    expect(await setEventRated("tournament", 999999, true)).toMatchObject({ ok: false, code: "RT_NOT_FOUND" });
  });
});

describe("a correction, a void, a walkover: the ledger follows the result", () => {
  it("replaces the row of a corrected result and recomputes: equal to a replay from scratch, and to a ledger rebuilt from nothing", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult(), await adult()];
    const ids = await entered(t.id, users);
    const d = await drawn(t.id);
    const first = d.matches.filter((m) => m.status === "scheduled")[0];
    await playOut(t.id);
    const before = await stored(venueId, "badminton", "singles");
    // The result is put right: the other side won.
    const flipped = (await tournamentDetail(t.id))!.matches.find((m) => m.id === first.id)!;
    await result(first.id, flipped.winner === flipped.a ? flipped.b! : flipped.a!);
    expect(await live("tournament", t.id)).toEqual({ n: 6 });
    expect(await total("tournament", t.id)).toEqual({ n: 7 });
    const voided = (await getDb().prepare("SELECT voided_reason, played_on, play_order FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NOT NULL").get(t.id)) as { voided_reason: string; played_on: string; play_order: number };
    expect(voided.voided_reason).toBe("result_changed");
    // The new row keeps where the old one fell in the order.
    const kept = (await getDb().prepare("SELECT played_on, play_order FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND source_match = ? AND voided_at IS NULL").get(t.id, first.id)) as { played_on: string; play_order: number };
    expect(kept).toEqual({ played_on: voided.played_on, play_order: voided.play_order });
    expect(await stored(venueId, "badminton", "singles")).not.toEqual(before);
    await expectReplay(venueId, "badminton", "singles");
    // Rebuild the event's ledger from nothing: the same ratings, to the last decimal.
    const now = await stored(venueId, "badminton", "singles");
    await getDb().prepare("DELETE FROM rated_results WHERE source_kind = 'tournament' AND source_id = ?").run(t.id);
    await getDb().prepare("DELETE FROM rating_syncs WHERE source_kind = 'tournament' AND source_id = ?").run(t.id);
    await syncRatedEvent("tournament", t.id);
    const rebuilt = await stored(venueId, "badminton", "singles");
    for (const u of users) expect(rebuilt.get(`user:${u.id}`)).toEqual(now.get(`user:${u.id}`));
    expect(ids).toHaveLength(4);
  });

  it("is idempotent, and two deliveries of the same result are one", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    await playOut(t.id);
    const before = await stored(venueId, "badminton", "singles");
    expect(await syncRatedEvent("tournament", t.id)).toMatchObject({ added: 0, voided: 0, pools: [] });
    await Promise.all([syncRatedEvent("tournament", t.id), syncRatedEvent("tournament", t.id), ratedAfter("tournament", t.id), ratedAfter("tournament", t.id)]);
    expect(await live("tournament", t.id)).toEqual({ n: 3 });
    expect(await total("tournament", t.id)).toEqual({ n: 3 });
    expect(await stored(venueId, "badminton", "singles")).toEqual(before);
    // The scheduled catch-up reads what changed since an event was last read (other tests' events that were drawn without a result), then finds nothing to do.
    await ratingsCatchUp();
    expect((await ratingsCatchUp()).events).toBe(0);
    expect(await total("tournament", t.id)).toEqual({ n: 3 });
  });

  it("catches up an event whose results changed without a hook being called", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    const d = (await tournamentDetail(t.id))!;
    // A result written straight to the table, as if the hook never ran.
    const m = d.matches.find((x) => x.status === "scheduled")!;
    await getDb().prepare("UPDATE tournament_matches SET status = 'done', winner = ?, score = '21-10, 21-12' WHERE id = ?").run(m.a, m.id);
    expect(await live("tournament", t.id)).toEqual({ n: 0 });
    expect((await ratingsCatchUp()).events).toBeGreaterThanOrEqual(1);
    expect(await live("tournament", t.id)).toEqual({ n: 1 });
    await expectReplay(venueId, "badminton", "singles");
  });

  it("leaves out group results the event's own rules void (a disqualified entrant's), and keeps those that stand (a withdrawn one's)", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult(), await adult()];
    const ids = await entered(t.id, users);
    await drawn(t.id);
    // Play the first two matches that can be.
    const d0 = (await tournamentDetail(t.id))!;
    const played = d0.matches.filter((m) => m.status === "scheduled").slice(0, 2);
    for (const m of played) await result(m.id, m.a!);
    expect(await live("tournament", t.id)).toEqual({ n: 2 });
    // Somebody who played is disqualified: their group results are void by default, so the rows go.
    const dq = played[0].a!;
    expect((await takeOut(dq, "disqualified", "rule breach")).ok).toBe(true);
    const mine = (await getDb().prepare("SELECT source_match FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL").all(t.id)) as { source_match: number }[];
    const stillCounted = new Set(mine.map((r) => r.source_match));
    for (const m of played) {
      const involved = m.a === dq || m.b === dq;
      expect(stillCounted.has(m.id), `match ${m.id}`).toBe(!involved);
    }
    await expectReplay(venueId, "badminton", "singles");
    expect(ids).toContain(dq);
  });

  it("counts a walkover as nothing: the row is there to explain, and moves no rating and no count", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult(), await adult()];
    const ids = await entered(t.id, users);
    await drawn(t.id);
    const before = Object.fromEntries(await Promise.all(users.map(async (u) => [u.id, await ratingOf(u.id)])));
    // Somebody withdraws after the draw: their matches are walkovers to the others.
    expect((await takeOut(ids[0], "withdrawn")).ok).toBe(true);
    const rows = (await getDb().prepare("SELECT kind, weight FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL").all(t.id)) as { kind: string; weight: string }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "walkover" && Number(r.weight) === 0)).toBe(true);
    const after = await poolStandings(venueId, "badminton", "singles");
    expect(after.filter((s) => users.some((u) => s.id === u.id))).toHaveLength(0);
    for (const u of users) expect((await ratingOf(u.id)) ?? undefined).toBe(before[u.id] ?? undefined);
    await expectReplay(venueId, "badminton", "singles");
  });

  it("a called-off tournament's results leave the ratings", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult()];
    await entered(t.id, users);
    const d = await drawn(t.id);
    const first = d.matches.find((m) => m.status === "scheduled")!;
    await result(first.id, first.a!);
    expect(await live("tournament", t.id)).toEqual({ n: 1 });
    const { cancelTournament } = await import("../src/lib/tournaments");
    expect((await cancelTournament(t.id)).ok).toBe(true);
    expect(await live("tournament", t.id)).toEqual({ n: 0 });
    await expectReplay(venueId, "badminton", "singles");
  });

  it("corrects a knockout result through the organiser's own correction, and the ledger follows it", async () => {
    const t = await tournament({ format: "knockout" });
    const users = [await adult(), await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    const d = (await tournamentDetail(t.id))!;
    const semi = d.matches.filter((m) => m.round === 1 && m.status === "scheduled");
    await result(semi[0].id, semi[0].a!);
    await result(semi[1].id, semi[1].a!);
    expect(await live("tournament", t.id)).toEqual({ n: 2 });
    const final = (await tournamentDetail(t.id))!.matches.find((m) => m.round === 2)!;
    await result(final.id, final.a!);
    expect(await live("tournament", t.id)).toEqual({ n: 3 });
    // A semi-final's result put right after the final has been played is a correction the organiser confirms.
    const preview = await previewResult(semi[0].id, { winner: semi[0].b!, score: "18-21, 19-21" });
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true });
    if (preview.ok) {
      const done = await applyCorrection(semi[0].id, { winner: semi[0].b!, score: "18-21, 19-21" }, { mode: "standings_only", reason: "Wrong side entered", token: preview.value.token }, { id: ownerId, name: "Owner" });
      expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
    }
    // The semi-final's row was replaced by the corrected result, and the final's stands as it was played.
    expect(await live("tournament", t.id)).toEqual({ n: 3 });
    expect((await total("tournament", t.id)).n).toBe(4);
    await expectReplay(venueId, "badminton", "singles");
  });
});

describe("box leagues", () => {
  it("rate results staff enter, drop a struck one, and bring a restored one back", async () => {
    const made = await createLeague({ venueId, name: "Rated Ladder", sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1) }, ownerId);
    if (!made.ok) throw new Error(made.error);
    const league = made.value;
    expect(await setEventRated("league", league.id, true)).toMatchObject({ ok: true });
    const people: { user: User; playerId: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const user = await adult("Boxer");
      const joined = await join(user, league.id);
      if (!joined.ok) throw new Error(joined.error);
      people.push({ user, playerId: joined.value.id });
    }
    const s = await startSeason(league.id, { startsOn: today }, today);
    if (!s.ok) throw new Error(s.error);
    // Starting it is no longer a time to change what counts.
    expect(await setEventRated("league", league.id, false)).toMatchObject({ ok: false, code: "RT_STARTED" });
    const matches = (await leagueDetail(league.id))!.matches;
    expect(matches).toHaveLength(3);
    for (const m of matches) expect((await decideResult(m.id, ownerId, { winner: Math.min(m.a, m.b), score: "21-10, 21-12" })).ok).toBe(true);
    expect(await live("league", league.id)).toEqual({ n: 3 });
    await expectReplay(venueId, "badminton", "singles");
    const lowest = Math.min(...people.map((p) => p.playerId));
    const top = people.find((p) => p.playerId === lowest)!;
    const standing = (await poolStandings(venueId, "badminton", "singles")).find((x) => x.id === top.user.id)!;
    expect(standing).toMatchObject({ wins: 2, losses: 0, games: 2 });
    // The venue strikes one: gone from the ledger, and everything replayed.
    const struck = matches[0];
    expect((await decideResult(struck.id, ownerId, { void: true })).ok).toBe(true);
    expect(await live("league", league.id)).toEqual({ n: 2 });
    await expectReplay(venueId, "badminton", "singles");
    // And put back to be played, then decided again: restored.
    expect((await decideResult(struck.id, ownerId, { clear: true })).ok).toBe(true);
    expect(await live("league", league.id)).toEqual({ n: 2 });
    expect((await decideResult(struck.id, ownerId, { winner: Math.min(struck.a, struck.b), score: "21-10, 21-12" })).ok).toBe(true);
    expect(await live("league", league.id)).toEqual({ n: 3 });
    await expectReplay(venueId, "badminton", "singles");
    expect((await total("league", league.id)).n).toBe(4);
  });
});

describe("teams, and the games of a team match", () => {
  async function side(label: string, size = 3) {
    const captain = await adult(`${label} Captain`);
    n++;
    const made = await createTeam(captain.id, { name: `${label} ${n}`, sport: "badminton", published: true });
    if (!made.ok) throw new Error(made.error);
    const players: User[] = [];
    for (let i = 1; i < size; i++) {
      const p = await adult(`${label} Player`);
      const link = await createInviteLink(captain.id, made.value.id);
      if (!link.ok) throw new Error(link.error);
      const done = await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
      if (!done.ok) throw new Error(done.error);
      players.push(p);
    }
    const view = (await teamView(made.value.id, captain.id))!;
    return { captain, team: made.value, members: view.roster!.map((m) => m.id), players };
  }

  it("rates each singles and doubles game for the people picked, and the teams for the match", async () => {
    const startsOn = addDays(today, 200 + (n % 7));
    const lg = await createTeamLeague({ venueId, name: `Rated League ${n}`, sport: "badminton", startsOn, endsOn: addDays(startsOn, 100), courtIds: courts }, ownerId);
    if (!lg.ok) throw new Error(lg.error);
    expect(await setEventRated("team_league", lg.value.id, true)).toMatchObject({ ok: true });
    const home = await side("Home");
    const away = await side("Away");
    for (const s of [home, away]) {
      const done = await enterTeam(s.captain.id, lg.value.id, { teamId: s.team.id, memberIds: s.members });
      if (!done.ok) throw new Error(done.error);
    }
    const gen = await generateFixtures(lg.value.id, [{ date: addDays(startsOn, 1), startMin: 9 * 60 }]);
    if (!gen.ok) throw new Error(gen.error);
    const fixture = (await teamLeagueDetail(lg.value.id, { forStaff: true }))!.fixtures[0];
    // Lineups: games 1 and 3 are singles, game 2 doubles.
    const picks = (m: number[]) => [{ rubber: 1, memberIds: [m[0]] }, { rubber: 2, memberIds: [m[0], m[1]] }, { rubber: 3, memberIds: [m[1]] }];
    // A fixture's home side is whichever team the generator made it.
    const sides = [home, away];
    const homeIsFirst = fixture.home.name === home.team.name;
    const [h, a] = homeIsFirst ? sides : [away, home];
    expect((await setLineup(h.captain.id, fixture.id, picks(h.members))).ok).toBe(true);
    expect((await setLineup(a.captain.id, fixture.id, picks(a.members))).ok).toBe(true);
    // Home wins games 1 and 2, away game 3.
    const rubbers = [
      { winner: "home", score: "21-10, 21-12" },
      { winner: "home", score: "21-15, 21-18" },
      { winner: "away", score: "10-21, 12-21" },
    ];
    expect((await decideFixture(fixture.id, ownerId, { rubbers })).ok).toBe(true);
    const rows = (await getDb().prepare("SELECT format, unit_no, outcome FROM rated_results WHERE source_kind = 'team_league' AND source_id = ? AND voided_at IS NULL ORDER BY format, unit_no").all(lg.value.id)) as { format: string; unit_no: number; outcome: string }[];
    expect(rows.map((r) => `${r.format}:${r.unit_no}`)).toEqual(["doubles:2", "singles:1", "singles:3", "team:0"]);
    // The teams' result: home won two games to one.
    expect(Number(rows.find((r) => r.format === "team")!.outcome)).toBe(1);
    await expectReplay(venueId, "badminton", "singles");
    await expectReplay(venueId, "badminton", "doubles");
    await expectReplay(venueId, "badminton", "team");
    // The team has a rating of its own, and so do the people picked, in singles and doubles.
    const teamStanding = (await poolStandings(venueId, "badminton", "team")).find((s) => s.kind === "team" && s.id === h.team.id)!;
    expect(teamStanding).toMatchObject({ wins: 1, losses: 0 });
    expect(teamStanding.rating).toBeGreaterThan(1000);
    const awayTeam = (await poolStandings(venueId, "badminton", "team")).find((s) => s.kind === "team" && s.id === a.team.id)!;
    expect(awayTeam.rating).toBeLessThan(1000);
    // The members of a team see its rating; nobody else does.
    expect((await myRatings(h.players[0].id)).teams.map((t) => t.teamId)).toContain(h.team.id);
    expect((await myRatings((await adult()).id)).teams).toEqual([]);
    expect(await ratingOf(h.captain.id, "doubles")).toBeDefined();
    expect(Number(await ratingOf(h.captain.id, "singles"))).toBeGreaterThan(1000);
    // The people on the losing side's doubles pair both lost it.
    expect(Number(await ratingOf(a.captain.id, "doubles"))).toBeLessThan(1000);
    // A forfeit voids none of that for the other fixtures, and a decided fixture put right is replaced.
    expect((await decideFixture(fixture.id, ownerId, { void: true })).ok).toBe(true);
    expect(await live("team_league", lg.value.id)).toEqual({ n: 0 });
    await expectReplay(venueId, "badminton", "team");
    expect((await decideFixture(fixture.id, ownerId, { clear: true })).ok).toBe(true);
    expect((await decideFixture(fixture.id, ownerId, { rubbers })).ok).toBe(true);
    expect(await live("team_league", lg.value.id)).toEqual({ n: 4 });
    await expectReplay(venueId, "badminton", "singles");
    // Forfeit: every game is a walkover and moves nothing.
    expect((await decideFixture(fixture.id, ownerId, { forfeitBy: fixture.away.id })).ok).toBe(true);
    const walk = (await getDb().prepare("SELECT kind FROM rated_results WHERE source_kind = 'team_league' AND source_id = ? AND voided_at IS NULL").all(lg.value.id)) as { kind: string }[];
    expect(walk.length).toBe(4);
    expect(walk.every((r) => r.kind === "walkover")).toBe(true);
    await expectReplay(venueId, "badminton", "team");
  });
});

describe("teams in a tournament", () => {
  it("rates a named team on a team match; a typed team has nobody to rate, so its match is not counted", async () => {
    const t = await tournament({ format: "knockout", entryKind: "team", roster: { min: 2, max: 4 }, maxEntries: 8 });
    const mk = async (label: string) => {
      const captain = await adult(`${label} Cap`);
      n++;
      const made = await createTeam(captain.id, { name: `${label} Side ${n}`, sport: "badminton", published: true });
      if (!made.ok) throw new Error(made.error);
      const p = await adult(`${label} P`);
      const link = await createInviteLink(captain.id, made.value.id);
      if (!link.ok) throw new Error(link.error);
      await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
      const ids = (await teamView(made.value.id, captain.id))!.roster!.map((m) => m.id);
      const e = await enter(captain, t.id, { teamId: made.value.id, rosterMemberIds: ids });
      if (!e.ok) throw new Error(e.error);
      return { teamId: made.value.id, entryId: e.value.id, captain };
    };
    const one = await mk("North");
    const two = await mk("South");
    const typed = await adult("Typist");
    expect((await enter(typed, t.id, { teamName: "Typed Four", roster: ["A One", "B Two"] })).ok).toBe(true);
    await drawn(t.id);
    // Play whatever is playable, the first side winning.
    await playOut(t.id);
    const rows = (await getDb().prepare("SELECT format, outcome FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL").all(t.id)) as { format: string; outcome: string }[];
    // Every counted match is between two named teams: the typed team's matches are not in the ledger.
    expect(rows.every((r) => r.format === "team")).toBe(true);
    const played = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id = ? AND status = 'done' AND entry_a IS NOT NULL AND entry_b IS NOT NULL").get(t.id)) as { n: number };
    expect(played.n).toBeGreaterThan(rows.length);
    const subjects = (await getDb().prepare("SELECT DISTINCT subject_kind FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id WHERE r.source_id = ? AND r.source_kind = 'tournament'").all(t.id)) as { subject_kind: string }[];
    expect(subjects.every((s) => s.subject_kind === "team")).toBe(true);
    await expectReplay(venueId, "badminton", "team");
    const standings = await poolStandings(venueId, "badminton", "team");
    expect(standings.filter((x) => [one.teamId, two.teamId].includes(x.id)).every((s) => s.kind === "team")).toBe(true);
  });
});

describe("what each reader may see", () => {
  it("never ranks or exposes a child: the guardian sees it, nobody else, and no public board, API or suggestion names them", async () => {
    const t = await tournament();
    const mum = await adult("Mum", { adult: true, rankPublicly: true, rankName: "Mum Ace" });
    const other = await adult("Other");
    const third = await adult("Third");
    const made = await addManaged(mum.id, { displayName: "Aina Secret", relationship: "parent", authority: true, birthYear: new Date().getFullYear() - 10 }, mum.name);
    if (!made.ok) throw new Error(made.error);
    const kid = made.person.id;
    const asKid = (await guardianEntrant(mum, kid)) as Entrant;
    const kidEntry = await enterAs(asKid, t.id);
    if (!kidEntry.ok) throw new Error(kidEntry.error);
    await entered(t.id, [other, third]);
    await drawn(t.id);
    // The child wins everything they play.
    for (let i = 0; i < 4; i++) {
      const d = (await tournamentDetail(t.id))!;
      const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null && m.winner === null && (m.a === kidEntry.value.id || m.b === kidEntry.value.id));
      if (!next) break;
      await result(next.id, kidEntry.value.id);
    }
    await playOut(t.id);
    const rated = (await getDb().prepare("SELECT subject_kind FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id WHERE r.source_kind = 'tournament' AND r.source_id = ? AND s.subject_kind = 'participant'").all(t.id)) as unknown[];
    expect(rated.length).toBeGreaterThan(0);
    // The guardian sees the child's rating under the child's name.
    const mine = await myRatings(mum.id);
    const forKid = mine.who.find((w) => w.participantId === kid)!;
    expect(forKid.name).toBe("Aina Secret");
    expect(forKid.pools[0]).toMatchObject({ sport: "badminton", format: "singles" });
    expect(await mayViewSubject(mum.id, { kind: "participant", id: kid })).toBe(true);
    expect(await mayViewSubject(other.id, { kind: "participant", id: kid })).toBe(false);
    expect((await myRatings(other.id)).who.map((w) => w.participantId)).toEqual([null]);
    // Nobody else's history reaches them.
    const history = await ratingHistory(venueId, "badminton", "singles", { kind: "participant", id: kid });
    expect(history.length).toBeGreaterThan(0);
    // The public board never lists them, however well they did (and Mum, who opted in as an adult, is not ranked for her child's results).
    const board = await venueBoard(venueId, "badminton", "singles");
    expect(JSON.stringify(board)).not.toContain("Aina");
    expect(board!.rows.every((r) => r.name !== "")).toBe(true);
    // The opponents' own history never names the child, only "a junior player" (an empty label), and shows no rating of theirs.
    const against = await ratingHistory(venueId, "badminton", "singles", { kind: "user", id: other.id });
    const vs = against.find((l) => l.opponents.some((o) => o.junior));
    if (vs) {
      expect(vs.opponents.find((o) => o.junior)).toEqual({ label: "", junior: true });
      expect(vs.opponentRating).toBeNull();
      expect(vs.expectedExact).toBe(false);
      expect(vs.expected! % 10).toBe(0);
    }
    // The data export of the child's guardian carries the child's record; another account's carries none of it.
    const exp = (await exportCustomerData(other.id))!;
    expect(JSON.stringify(exp.ratings)).not.toContain("Aina");
    // Routes: signed in as somebody else, the child's history is not found; the public API shows nothing of them.
    const cookie = `${SESSION_COOKIE}=${(await createSession(other.id)).token}`;
    const res = await myRatingsRoute.GET(new NextRequest(`http://localhost/api/my/ratings?venueId=${venueId}&sport=badminton&format=singles&participantId=${kid}`, { headers: { cookie } }));
    expect(res.status).toBe(404);
    const pub = await publicRankings.GET(new NextRequest(`http://localhost/api/venues/${venueId}/rankings?sport=badminton&format=singles`), { params: Promise.resolve({ id: String(venueId) }) });
    expect(JSON.stringify(await pub.json())).not.toContain("Aina");
  });

  it("lists on a public board only people who opted in (declared adults, under the name they gave) and published teams, once non-provisional", async () => {
    const t = await tournament({ maxEntries: 16, startHour: 8, endHour: 22 }, true, 2);
    const listed = await adult("Listed", { adult: true, rankPublicly: true, rankName: "Lena L" });
    const quiet = await adult("Quiet");
    const unsaid = await adult("Unsaid", null as unknown as Record<string, unknown>);
    const others = [await adult(), await adult(), await adult(), await adult(), await adult(), await adult(), await adult()];
    // Everybody plays everybody once: ten players, nine games each, so everyone is past provisional.
    await entered(t.id, [listed, quiet, unsaid, ...others]);
    await drawn(t.id);
    await playOut(t.id);
    const all = await poolStandings(venueId, "badminton", "singles");
    expect(all.find((s) => s.id === listed.id)!.provisional).toBe(false);
    const board = (await venueBoard(venueId, "badminton", "singles"))!;
    const names = board.rows.map((r) => r.name);
    expect(names).toContain("Lena L");
    // Only those who said yes: not the quiet one, not the one who never said anything, not the rest.
    expect(board.rows.filter((r) => r.name === "Lena L")).toHaveLength(1);
    for (const u of [quiet, unsaid, ...others]) expect(names.join()).not.toContain(u.name);
    // A real name is not shown unless it was chosen as the rank name.
    expect(names.join()).not.toContain(listed.name);
    const row = board.rows.find((r) => r.name === "Lena L")!;
    expect(row).toMatchObject({ kind: "person", games: 9, rank: expect.any(Number) });
    expect(row.form.length).toBeLessThanOrEqual(R.formLength);
    expect(row.games).toBe(row.wins + row.draws + row.losses);
    // A season filter shows the year's results; another year has none.
    const year = Number(today.slice(0, 4));
    const thisYear = await venueBoard(venueId, "badminton", "singles", { season: year });
    const other = await venueBoard(venueId, "badminton", "singles", { season: year - 5 });
    expect(thisYear!.rows.map((r) => r.name)).toContain("Lena L");
    expect(other!.rows).toEqual([]);
    expect((await boardChoices(venueId)).seasons).toContain(year);
    // Who is left once they take it back: nobody is named.
    expect(await saveProfile(listed.id, { rankPublicly: false })).toMatchObject({ ok: true });
    expect((await venueBoard(venueId, "badminton", "singles"))!.rows.map((r) => r.name)).not.toContain("Lena L");
    // Somebody who says they are under 18 cannot be listed or share a rating.
    const teen = await adult("Teen", { adult: false });
    expect(await saveProfile(teen.id, { rankPublicly: true, rankName: "Teen" })).toMatchObject({ ok: false, code: "RT_ADULTS_ONLY" });
    expect(await saveProfile(teen.id, { ratingShared: true })).toMatchObject({ ok: false, code: "RT_ADULTS_ONLY" });
    expect(await saveProfile(listed.id, { rankPublicly: true, rankName: " " })).toMatchObject({ ok: false, code: "RT_NAME_NEEDED" });
    expect(await saveProfile(listed.id, { levelBasis: "magic" })).toMatchObject({ ok: false, code: "RT_BASIS" });
  });

  it("lists a team only once its captain has published it", async () => {
    const startsOn = addDays(today, 300 + (n % 9));
    const lg = await createTeamLeague({ venueId, name: `Published League ${n}`, sport: "badminton", startsOn, endsOn: addDays(startsOn, 100), courtIds: courts, rosterMin: 2 }, ownerId);
    if (!lg.ok) throw new Error(lg.error);
    await setEventRated("team_league", lg.value.id, true);
    const mk = async (label: string, published: boolean) => {
      const captain = await adult(`${label} Cap`);
      n++;
      const t = await createTeam(captain.id, { name: `${label} Team ${n}`, sport: "badminton", published });
      if (!t.ok) throw new Error(t.error);
      const p = await adult(`${label} P`);
      const link = await createInviteLink(captain.id, t.value.id);
      if (!link.ok) throw new Error(link.error);
      await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
      const members = (await teamView(t.value.id, captain.id))!.roster!.map((m) => m.id);
      const e = await enterTeam(captain.id, lg.value.id, { teamId: t.value.id, memberIds: members });
      if (!e.ok) throw new Error(e.error);
      return { name: t.value.name, id: t.value.id };
    };
    const open = await mk("Open", true);
    const hidden = await mk("Hidden", false);
    // Play enough of the pair's matches (the league is a double round robin) for both to pass provisional.
    const gen = await generateFixtures(lg.value.id, Array.from({ length: 4 }, (_, i) => ({ date: addDays(startsOn, 1 + i * 7), startMin: 9 * 60 })));
    if (!gen.ok) throw new Error(gen.error);
    const fixtures = (await teamLeagueDetail(lg.value.id, { forStaff: true }))!.fixtures;
    for (const f of fixtures) await decideFixture(f.id, ownerId, { rubbers: [{ winner: "home", score: "21-10, 21-12" }, { winner: "home", score: "21-10, 21-12" }, { winner: "home", score: "21-10, 21-12" }] });
    // One pair meets once: provisional. Bring them past it by hand so the board's rule is what is tested.
    await getDb().prepare("UPDATE rating_subjects SET games = 20 WHERE subject_kind = 'team' AND venue_id = ? AND format = 'team'").run(venueId);
    const board = (await venueBoard(venueId, "badminton", "team"))!;
    expect(board.rows.map((r) => r.name)).not.toContain(hidden.name);
    expect(open.id).toBeGreaterThan(0);
  });

  it("shows only what each branch allows on a business-wide board", async () => {
    // A venue on its own has none.
    expect(await businessBoard(venueId, "badminton", "singles")).toBeNull();
    const biz = await getDb().prepare("INSERT INTO businesses (name) VALUES ('Rated Group') RETURNING id").get() as { id: number };
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(biz.id, venueId);
    expect(await businessBoard(venueId, "badminton", "singles")).toBeNull();
    await setBusinessBoard(venueId, true);
    const board = await businessBoard(venueId, "badminton", "singles");
    expect(board).not.toBeNull();
    expect(board!.rows.every((r) => r.venue !== undefined)).toBe(true);
    await setBusinessBoard(venueId, false);
    expect(await businessBoard(venueId, "badminton", "singles")).toBeNull();
    await getDb().prepare("UPDATE venues SET business_id = NULL WHERE id = ?").run(venueId);
  });

  it("explains each result to the player: the opponent, what was expected, what happened and how far it moved", async () => {
    const t = await tournament();
    const a = await adult("Alice", { adult: true, ratingShared: true });
    const b = await adult("Bob");
    const c = await adult("Cara");
    await entered(t.id, [a, b, c]);
    await drawn(t.id);
    await playOut(t.id);
    const lines = await ratingHistory(venueId, "badminton", "singles", { kind: "user", id: a.id });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({ eventName: t.name, kind: "played", counted: true, excluded: false, beforeReset: false });
      expect(line.ratingBefore).not.toBeNull();
      expect(line.ratingAfter).not.toBeNull();
      expect(line.change).toBeCloseTo(line.ratingAfter! - line.ratingBefore!, 2);
      expect(line.k).toBe(40);
      expect(["win", "loss"]).toContain(line.result);
      // The chance it was given, and the change it made, agree with the rule.
      const e = (line.expected ?? 0) / 100;
      const got = line.result === "win" ? 1 : 0;
      if (line.expectedExact) expect(line.change).toBeCloseTo(40 * (got - e), 0);
    }
    // Bob and Cara did not choose to show a rating: Alice is told that theirs is private.
    expect(lines.every((l) => l.opponentRating === null && l.expectedExact === false)).toBe(true);
    // Alice chose to show hers: Bob's history of the match against her carries it.
    const bobs = await ratingHistory(venueId, "badminton", "singles", { kind: "user", id: b.id });
    const vsAlice = bobs.find((l) => l.opponents.some((o) => o.label === a.name || o.label.includes("Alice")));
    expect(vsAlice?.opponentRating).not.toBeNull();
    expect(vsAlice?.expectedExact).toBe(true);
  });
});

describe("managers: leave a result out, start a rating again", () => {
  it("excludes and restores a result with a reason, recomputing the pool, and logs it", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    await playOut(t.id);
    const key = (await getDb().prepare("SELECT source_match FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL ORDER BY id LIMIT 1").get(t.id)) as { source_match: number };
    const before = await stored(venueId, "badminton", "singles");
    const ledger = { sourceKind: "tournament" as const, sourceId: t.id, sourceMatch: key.source_match, unitNo: 0 };
    expect(await excludeResult(venueId, ledger, "x", "Mira")).toMatchObject({ ok: false, code: "RT_REASON" });
    expect(await excludeResult(venueId, { ...ledger, sourceMatch: 99999999 }, "Played on the wrong court", "Mira")).toMatchObject({ ok: false, code: "RT_NOT_A_RESULT" });
    const done = await excludeResult(venueId, ledger, "Played on the wrong court", "Mira");
    expect(done.ok).toBe(true);
    expect(await excludeResult(venueId, ledger, "Played on the wrong court", "Mira")).toMatchObject({ ok: false, code: "RT_ALREADY_EXCLUDED" });
    await expectReplay(venueId, "badminton", "singles");
    expect(await stored(venueId, "badminton", "singles")).not.toEqual(before);
    // The staff view says which results count and why.
    const view = await staffRatings(venueId);
    const row = view.results.find((r) => r.sourceMatch === key.source_match && r.sourceId === t.id)!;
    expect(row.excluded).toMatchObject({ reason: "Played on the wrong court", by: "Mira" });
    expect(row.counted).toBe(false);
    // The exclusion belongs to the result: a correction of it does not bring it back.
    const d = (await tournamentDetail(t.id))!;
    const m = d.matches.find((x) => x.id === key.source_match)!;
    await result(m.id, m.winner === m.a ? m.b! : m.a!);
    expect((await staffRatings(venueId)).results.find((r) => r.sourceMatch === key.source_match && r.sourceId === t.id)!.excluded).not.toBeNull();
    await expectReplay(venueId, "badminton", "singles");
    // Lifted, it is back.
    expect(await liftExclusion(venueId, (done as { value: { id: number } }).value.id, "", "Mira")).toMatchObject({ ok: false, code: "RT_REASON" });
    expect((await liftExclusion(venueId, (done as { value: { id: number } }).value.id, "Checked: it was right", "Mira")).ok).toBe(true);
    expect(await liftExclusion(venueId, (done as { value: { id: number } }).value.id, "Checked again", "Mira")).toMatchObject({ ok: false, code: "RT_NOT_EXCLUDED" });
    await expectReplay(venueId, "badminton", "singles");
    // Another venue's manager finds nothing of it.
    expect(await excludeResult(venueId + 999, ledger, "Not mine to leave out", "Mira")).toMatchObject({ ok: false, code: "RT_NOT_A_RESULT" });
  });

  it("starts a rating again: the earlier results stay for the people who played them, the subject's own rating and record begin again", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    await playOut(t.id);
    const target = users[0];
    const beforeOthers = await stored(venueId, "badminton", "singles");
    expect(await resetSubject(venueId, { sport: "badminton", format: "singles" }, { kind: "user", id: target.id }, "", "Mira")).toMatchObject({ ok: false, code: "RT_REASON" });
    expect(await resetSubject(venueId, { sport: "badminton", format: "singles" }, { kind: "user", id: 99999999 }, "Back from a long break", "Mira")).toMatchObject({ ok: false, code: "RT_NO_SUBJECT" });
    expect((await resetSubject(venueId, { sport: "badminton", format: "singles" }, { kind: "user", id: target.id }, "Back from a long break", "Mira")).ok).toBe(true);
    const after = await stored(venueId, "badminton", "singles");
    // With nothing counted since, they have no rating to show: it starts again at the first result.
    expect(after.has(`user:${target.id}`)).toBe(false);
    // Everybody else's rating is exactly as it was: what they did against them still stands.
    for (const u of users.slice(1)) expect(after.get(`user:${u.id}`)).toEqual(beforeOthers.get(`user:${u.id}`));
    await expectReplay(venueId, "badminton", "singles");
    // History is kept, flagged as before the restart.
    const history = await ratingHistory(venueId, "badminton", "singles", { kind: "user", id: target.id });
    expect(history.length).toBe(3);
    expect(history.every((h) => h.beforeReset)).toBe(true);
    expect((await staffRatings(venueId)).resets[0]).toMatchObject({ reason: "Back from a long break", by: "Mira" });
    expect((await poolStandings(venueId, "badminton", "singles")).find((s) => s.id === target.id)).toBeUndefined();
  });

  it("is a manager's: the desk is refused, and each change is in the activity log", async () => {
    const t = await tournament({}, false);
    const call = (method: "GET" | "POST", cookie: string, body?: unknown, query = `?venueId=${venueId}`) =>
      (method === "GET" ? adminRatings.GET : adminRatings.POST)(new NextRequest(`http://localhost/api/admin/ratings${method === "GET" ? query : ""}`, { method, headers: { cookie }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    expect(managerOnly("POST", "/api/admin/ratings")).toBe(true);
    expect(managerOnly("GET", "/api/admin/ratings")).toBe(true);
    expect(STAFF_ACTIONS.ratings).toBe("POST /api/admin/ratings");
    expect((await call("GET", deskCookie)).status).toBe(403);
    expect((await call("POST", deskCookie, { venueId, action: "rated", kind: "tournament", id: t.id, rated: true })).status).toBe(403);
    expect((await call("GET", managerCookie)).status).toBe(200);
    expect((await call("POST", managerCookie, { venueId, action: "rated", kind: "tournament", id: t.id, rated: true })).status).toBe(200);
    expect((await call("POST", managerCookie, { venueId, action: "rated", kind: "tournament", id: t.id, rated: false })).status).toBe(200);
    expect((await call("POST", managerCookie, { venueId, action: "rated", kind: "tournament", id: 99999, rated: true })).status).toBe(404);
    expect((await call("POST", managerCookie, { venueId, action: "business", allowed: false })).status).toBe(200);
    expect((await call("POST", managerCookie, { venueId, action: "nothing" })).status).toBe(400);
    expect((await call("POST", managerCookie, { venueId: venueId + 999, action: "business", allowed: true })).status).toBe(403);
    const actions = (await listActivity([venueId], { limit: 100 })).map((a) => a.action);
    expect(actions).toContain("ratings.event_rated");
    expect(actions).toContain("ratings.event_unrated");
    expect(actions).toContain("ratings.business_board");
  });
});

describe("seeding a draw from ratings", () => {
  it("proposes seeds from non-provisional ratings only, and sets them only when the manager confirms what they were shown", async () => {
    // A history that makes a few players non-provisional: ten players, nine games each.
    const first = await tournament({ startHour: 8, endHour: 22 }, true, 2);
    const players = [await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded"), await adult("Seeded")];
    await entered(first.id, players);
    await drawn(first.id);
    await playOut(first.id);
    const next = await tournament({ format: "knockout" }, false);
    const newcomer = await adult("Newcomer");
    await entered(next.id, [...players.slice(0, 8), newcomer]);
    const proposal = await proposeSeeds(next.id);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    // A quarter of the field, best rating first; the newcomer has no rating and is not seeded.
    expect(proposal.value.seeds.length).toBe(2);
    expect(proposal.value.unrated).toBe(1);
    const ranked = proposal.value.seeds.map((s) => s.rating);
    expect([...ranked].sort((x, y) => y - x)).toEqual(ranked);
    expect(proposal.value.seeds.map((s) => s.seed)).toEqual([1, 2]);
    // Nothing is set until it is confirmed, and what is confirmed must be what was proposed.
    const entriesNow = async () => (await tournamentDetail(next.id))!.entries.filter((e) => e.seed !== null);
    expect(await entriesNow()).toHaveLength(0);
    expect(await applySeedProposal(next.id, [{ entryId: proposal.value.seeds[0].entryId, seed: 1 }])).toMatchObject({ ok: false, code: "RT_SEED_CHANGED" });
    expect(await entriesNow()).toHaveLength(0);
    expect(await applySeedProposal(next.id, proposal.value.seeds.map((s) => ({ entryId: s.entryId, seed: s.seed })))).toMatchObject({ ok: true });
    expect((await entriesNow()).map((e) => e.seed).sort()).toEqual([1, 2]);
    // Seeds already set are never replaced; and after the draw there is nothing to propose.
    expect(await applySeedProposal(next.id, proposal.value.seeds.map((s) => ({ entryId: s.entryId, seed: s.seed })))).toMatchObject({ ok: false, code: "RT_SEED_EXISTS" });
    await drawn(next.id);
    expect(await proposeSeeds(next.id)).toMatchObject({ ok: false, code: "RT_SEED_DRAWN" });
    expect((await setEntry(proposal.value.seeds[0].entryId, { seed: 3 })).ok).toBe(true);
  });
});

describe("erasing an account", () => {
  it("makes its place in the ledger '(removed)' at the rating it had, so nobody else's rating moves, and exports it first", async () => {
    const t = await tournament();
    const leaving = await adult("Leaver");
    const others = [await adult(), await adult(), await adult()];
    await entered(t.id, [leaving, ...others]);
    await drawn(t.id);
    await playOut(t.id);
    const exp = (await exportCustomerData(leaving.id))!;
    const mineBefore = exp.ratings as { ratings: { sport: string; format: string; games: number }[]; results: unknown[] };
    expect(mineBefore.ratings[0]).toMatchObject({ sport: "badminton", format: "singles", games: 3 });
    expect(mineBefore.results).toHaveLength(3);
    const beforeOthers = await stored(venueId, "badminton", "singles");
    expect((await eraseCustomer(leaving.id)).ok).toBe(true);
    // Their ratings are gone; they are '(removed)' on the rows, standing where they stood.
    const after = await stored(venueId, "badminton", "singles");
    expect(after.has(`user:${leaving.id}`)).toBe(false);
    const removed = (await getDb().prepare("SELECT frozen_rating, label FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id WHERE r.source_id = ? AND s.subject_kind = 'removed'").all(t.id)) as { frozen_rating: string | null; label: string }[];
    expect(removed).toHaveLength(3);
    expect(removed.every((r) => r.label === "" && r.frozen_rating !== null)).toBe(true);
    for (const o of others) expect(after.get(`user:${o.id}`)).toEqual(beforeOthers.get(`user:${o.id}`));
    await expectReplay(venueId, "badminton", "singles");
    expect(JSON.stringify(await staffRatings(venueId))).not.toContain(leaving.name);
    // Their name is in no ledger row, and the rows still explain the others' results.
    const rows = (await getDb().prepare("SELECT label FROM rated_result_subjects").all()) as { label: string }[];
    expect(rows.some((r) => r.label === leaving.name)).toBe(false);
  });
});

describe("a pool is recomputed under one lock, at once from two places", () => {
  it("gives the same ratings however results and recomputes interleave", async () => {
    const t = await tournament();
    const users = [await adult(), await adult(), await adult(), await adult()];
    await entered(t.id, users);
    await drawn(t.id);
    const d = (await tournamentDetail(t.id))!;
    const todo = d.matches.filter((m) => m.status === "scheduled" && m.a !== null && m.b !== null);
    // Results arrive together for players who share matches, with recomputes and a catch-up between them.
    await Promise.all([
      ...todo.map((m) => recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" })),
      recomputePool(venueId, "badminton", "singles"),
      ratingsCatchUp(),
      syncRatedEvent("tournament", t.id),
    ]);
    await syncRatedEvent("tournament", t.id);
    expect(await live("tournament", t.id)).toEqual({ n: todo.length });
    expect((await total("tournament", t.id)).n).toBe(todo.length);
    await expectReplay(venueId, "badminton", "singles");
    expect(await eventVenue("tournament", t.id)).toMatchObject({ venueId });
  });
});
