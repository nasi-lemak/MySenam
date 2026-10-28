import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { createCompetition } from "../src/lib/competitions";
import { getDb } from "../src/lib/db";
import { createLeague, join } from "../src/lib/leagues";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { changeTournament, createTournament, enter, withdraw, type TournamentInput } from "../src/lib/tournaments";

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

  it("are never fewer than those entered when staff lower them as entries arrive", async () => {
    // Under the same tournament row lock as an entry (changeTournament, enterAs): whichever comes second sees the first.
    for (let round = 0; round < 4; round++) {
      const id = await knockout(4);
      for (let i = 0; i < 2; i++) expect(await enter(await player(), id)).toMatchObject({ ok: true, value: { status: "entered" } });
      const target = 2 + (round % 2);
      const racers = [await player(), await player()];
      const [lowered, ...entries] = await Promise.all([changeTournament(id, { maxEntries: target }), ...racers.map((p) => enter(p, id))]);
      expect(entries.every((r) => r.ok)).toBe(true);
      const { max } = (await getDb().prepare("SELECT max_entries AS max FROM tournaments WHERE id = ?").get(id)) as { max: number };
      const c = await counts(id);
      expect(c.entered).toBeLessThanOrEqual(max);
      expect((c.entered ?? 0) + (c.waitlisted ?? 0)).toBe(4);
      if (lowered.ok) expect(max).toBe(target);
      else {
        expect(lowered.error).toMatch(/have entered: it cannot take fewer than that\.$/);
        expect(max).toBe(4);
      }
    }
  });

  it("lowered while an entry is being written, waits for it and then refuses to go below it", async () => {
    const id = await knockout(4);
    for (let i = 0; i < 2; i++) expect(await enter(await player(), id)).toMatchObject({ ok: true, value: { status: "entered" } });
    // The third entry is held after it is written and before it is committed, its lock on the tournament held.
    let written!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((r) => (written = r));
    const held = new Promise<void>((r) => (release = r));
    const db = getDb();
    const real = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = real(sql);
      if (!/INSERT INTO tournament_entries/.test(sql)) return statement;
      return {
        ...statement,
        run: async (...params: unknown[]) => {
          const done = await statement.run(...params);
          written();
          await held;
          return done;
        },
      };
    });
    try {
      const third = enter(await player(), id);
      await inside;
      spy.mockRestore();
      const lowered = changeTournament(id, { maxEntries: 2 });
      await new Promise((r) => setTimeout(r, 100));
      release();
      expect(await third).toMatchObject({ ok: true, value: { status: "entered" } });
      expect(await lowered).toMatchObject({ ok: false, error: "3 have entered: it cannot take fewer than that." });
    } finally {
      spy.mockRestore();
      release();
    }
    expect(await counts(id)).toEqual({ entered: 3 });
    expect(((await getDb().prepare("SELECT max_entries AS max FROM tournaments WHERE id = ?").get(id)) as { max: number }).max).toBe(4);
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
