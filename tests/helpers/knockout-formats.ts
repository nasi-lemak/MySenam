import { registerUser, type User } from "../../src/lib/auth";
import { addDays, todayISO } from "../../src/lib/time";
import {
  createTournament,
  enter,
  makeDraw,
  recordResult,
  tournamentDetail,
  type Match,
  type TournamentDetail,
  type TournamentInput,
} from "../../src/lib/tournaments";

/**
 * What the tests of consolation draws and double elimination (ADR 0032) share: a tournament on a day of its own, entrants, playing an
 * event by a rule, and the invariants every operation must leave (G3), read from the stored matches.
 */

export interface Env {
  venueId: number;
  ownerId: number;
  courts: number[];
}

export const fixed = () => 0.42;

const played = (m: Pick<Match, "status">) => m.status === "done" || m.status === "walkover" || m.status === "retired";

export function kit(env: Env, prefix: string) {
  let n = 0;
  let dayOffset = 3;
  const today = todayISO();

  async function player(): Promise<User> {
    n++;
    const made = await registerUser({ name: `${prefix} Player ${n}`, email: `${prefix}${n}@formats.test`, phone: `0138${prefix.length}${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    return made.user;
  }

  /** A tournament on days of its own (`days` of them), so no two hold the same hours. */
  async function tournament(over: Partial<TournamentInput> = {}, days = 1) {
    const day = addDays(today, dayOffset);
    dayOffset += days;
    const made = await createTournament(
      {
        venueId: env.venueId,
        name: `${prefix} Cup ${dayOffset}`,
        sport: "badminton",
        format: "knockout",
        teamSize: 1,
        level: null,
        entryFee: 0,
        maxEntries: 40,
        startsOn: day,
        endsOn: addDays(day, days - 1),
        startHour: 9,
        endHour: 21,
        matchMinutes: 30,
        courtIds: env.courts,
        ...over,
      },
      env.ownerId
    );
    if (!made.ok) throw new Error(made.error);
    return made.value;
  }

  /** `count` players entered, in order: the entry ids, first entered first. */
  async function field(tournamentId: number, count: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const made = await enter(await player(), tournamentId);
      if (!made.ok) throw new Error(made.error);
      ids.push(made.value.id);
    }
    return ids;
  }

  /** A tournament, entered and drawn (the same draw for the same count). */
  async function drawn(over: Partial<TournamentInput>, count: number, days = 1) {
    const t = await tournament(over, days);
    const ids = await field(t.id, count);
    const done = await makeDraw(t.id, fixed);
    if (!done.ok) throw new Error(done.error);
    return { t: done.value, ids };
  }

  /** The score as the sport's form writes it, from the first side's view. */
  const score = (m: Pick<Match, "a">, winner: number) => (winner === m.a ? "21-10, 21-12" : "10-21, 12-21");

  async function result(m: Pick<Match, "id" | "a">, winner: number) {
    const r = await recordResult(m.id, { winner, score: score(m, winner) });
    if (!r.ok) throw new Error(`${m.id}: ${r.error}`);
    return r.value;
  }

  /**
   * Play every match that can be played now, in the order they became playable, until `stop` says to leave one: the rule
   * names the winner of a match from its two sides. Returns the detail and the matches played.
   */
  async function play(
    tournamentId: number,
    rule: (m: Match, d: TournamentDetail) => number,
    stop: (m: Match, d: TournamentDetail) => boolean = () => false
  ) {
    const playedNow: Match[] = [];
    for (let guard = 0; guard < 400; guard++) {
      const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
      const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null && !stop(m, d));
      if (!next) return { d, playedNow };
      await result(next, rule(next, d));
      playedNow.push(next);
    }
    throw new Error("never finished");
  }

  return { player, tournament, field, drawn, result, play, score };
}

/** A match's name in a tournament, by where it is: "winners:2:1". */
export const at = (m: Pick<Match, "bracket" | "round" | "position">) => `${m.bracket}:${m.round}:${m.position}`;

/** The match at a place, as the tests name them. */
export function matchAt(d: TournamentDetail, place: string): Match {
  const found = d.matches.find((m) => at(m) === place);
  if (!found) throw new Error(`no match ${place}: ${d.matches.map(at).join(" ")}`);
  return found;
}

/** The rule "the entry entered first wins": the lowest id in the match. */
export const chalk = (m: Match) => Math.min(m.a!, m.b!);

/**
 * G3, read from the stored matches. Nobody is in two matches still to play; every side holds the entrant the match feeding it sent
 * (the winner by the winner's route, the loser by the loser's), or nobody where that match is not decided or sent nobody. With
 * `openIssues`, a record-only correction has left some sides as played (and says so as an issue): only the first is checked.
 */
export function violations(d: TournamentDetail, opts: { openIssues?: boolean } = {}): string[] {
  const out: string[] = [];
  const seen = new Map<number, number>();
  for (const m of d.matches) {
    if (m.a !== null && m.a === m.b) out.push(`match ${at(m)} has ${m.a} on both sides`);
    if (m.status !== "scheduled") continue;
    for (const e of [m.a, m.b]) {
      if (e === null) continue;
      if (seen.has(e)) out.push(`entrant ${e} is in two matches still to play: ${seen.get(e)} and ${m.id}`);
      seen.set(e, m.id);
    }
  }
  if (opts.openIssues) return out;
  for (const m of d.matches) {
    // A reset that is not needed has nobody in it.
    if (m.bracket === "grand" && m.round === 2 && m.status === "bye") {
      if (m.a !== null || m.b !== null) out.push("a reset not needed holds somebody");
      continue;
    }
    for (const slot of ["a", "b"] as const) {
      const feeders = d.matches.filter((f) => (f.next === m.id && f.nextSlot === slot) || (f.loserNext === m.id && f.loserNextSlot === slot));
      if (feeders.length > 1) out.push(`${at(m)} ${slot} has two feeders`);
      if (feeders.length === 0) continue;
      const f = feeders[0];
      const byWinner = f.next === m.id && f.nextSlot === slot;
      const decided = played(f) || f.status === "bye";
      const sent = !decided ? null : byWinner ? f.winner : f.status === "bye" || f.winner === null ? null : f.winner === f.a ? f.b : f.a;
      if (m[slot] !== sent) out.push(`${at(m)} ${slot} holds ${m[slot]}, but ${at(f)} (${f.status}, winner ${f.winner}) sent ${sent}`);
    }
  }
  return out;
}

/** A tournament as a shape that can be compared with another's: each match by its place, its sides by the order entered. */
export function shape(d: TournamentDetail, ids: number[]): string[] {
  const idx = (e: number | null) => (e === null ? "-" : String(ids.indexOf(e)));
  return d.matches
    .filter((m) => m.status !== "bye" || m.a !== null)
    .map((m) => `${at(m)} ${idx(m.a)} v ${idx(m.b)} ${m.status} ${idx(m.winner)}`)
    .sort();
}
