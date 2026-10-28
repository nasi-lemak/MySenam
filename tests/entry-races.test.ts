import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { createCompetition } from "../src/lib/competitions";
import { getDb } from "../src/lib/db";
import { createLeague, join } from "../src/lib/leagues";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, withdraw, type TournamentInput } from "../src/lib/tournaments";

/**
 * Entries arriving at once (audit R8, X3-4): a tournament's places are
 * counted and taken under its row lock, so it never takes more than its
 * size; a competition's cap on divisions holds across its divisions; and a
 * league never has the same player in it twice. Run on Postgres too.
 */

let ownerId: number;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 5;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Player ${n}`, email: `race${n}@cup.my`, phone: `01341${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function knockout(maxEntries: number, competitionId?: number) {
  const day = addDays(todayISO(), dayOffset++);
  const made = await createTournament(
    {
      venueId,
      ...(competitionId ? { competitionId } : {}),
      name: `Race Cup ${dayOffset}`,
      sport: "badminton",
      format: "knockout",
      teamSize: 1,
      level: null,
      entryFee: 0,
      maxEntries,
      startsOn: day,
      endsOn: day,
      startHour: 9,
      endHour: 21,
      courtIds: competitionId ? [] : courts,
    } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value.id;
}

const counts = async (tournamentId: number) =>
  Object.fromEntries(
    ((await getDb()
      .prepare("SELECT status, COUNT(*)::int AS n FROM tournament_entries WHERE tournament_id = ? GROUP BY status")
      .all(tournamentId)) as { status: string; n: number }[]).map((r) => [r.status, r.n])
  );

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues()).find((v) => v.courts.filter((c) => c.sport === "badminton").length >= 2)!;
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("a tournament's places, entered at once", () => {
  it("are never more than its size: of three entering for the last place, one is in and two wait", async () => {
    const id = await knockout(2);
    expect(await enter(await player(), id)).toMatchObject({ ok: true, value: { status: "entered" } });
    const racers = [await player(), await player(), await player()];
    const results = await Promise.all(racers.map((p) => enter(p, id)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.value.status : r.error)).sort()).toEqual(["entered", "waitlisted", "waitlisted"]);
    expect(await counts(id)).toEqual({ entered: 2, waitlisted: 2 });
  });

  it("are never more than its size when a place freed and new entries meet", async () => {
    const id = await knockout(2);
    const first = await enter(await player(), id);
    expect(await enter(await player(), id)).toMatchObject({ ok: true, value: { status: "entered" } });
    expect(await enter(await player(), id)).toMatchObject({ ok: true, value: { status: "waitlisted" } });
    if (!first.ok) throw new Error(first.error);
    const [out, ...late] = await Promise.all([withdraw(first.value.id), enter(await player(), id), enter(await player(), id)]);
    expect(out.ok).toBe(true);
    expect(late.every((r) => r.ok)).toBe(true);
    expect((await counts(id)).entered).toBe(2);
  });

  it("the same player entering twice at once is in once", async () => {
    const id = await knockout(8);
    const p = await player();
    const both = await Promise.all([enter(p, id), enter(p, id)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, error: "You have entered already." });
    expect(await counts(id)).toEqual({ entered: 1 });
  });

  it("a competition's cap on divisions holds when one player enters two at once", async () => {
    const day = addDays(todayISO(), dayOffset++);
    const c = await createCompetition(
      { venueId, name: "Race Championship", sport: "badminton", startsOn: day, endsOn: day, startMin: 9 * 60, endMin: 13 * 60, matchMinutes: 30, courtIds: courts, maxDivisionsPerPlayer: 1 },
      ownerId
    );
    if (!c.ok) throw new Error(c.error);
    const [a, b] = [await knockout(8, c.value.id), await knockout(8, c.value.id)];
    const p = await player();
    const both = await Promise.all([enter(p, a), enter(p, b)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, code: "DIVISION_LIMIT" });
  });
});

describe("a league", () => {
  it("has a player joining twice at once in it once, the second told so", async () => {
    const made = await createLeague({ venueId, name: "Race Ladder", sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(todayISO(), 1) }, ownerId);
    if (!made.ok) throw new Error(made.error);
    const p = await player();
    const both = await Promise.all([join(p, made.value.id), join(p, made.value.id)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, error: "You are in this league already." });
    const rows = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM league_players WHERE league_id = ? AND status = 'active'").get(made.value.id)) as { n: number };
    expect(rows.n).toBe(1);
  });
});
