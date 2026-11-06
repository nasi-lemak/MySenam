import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, makeDraw, withdraw, type TournamentInput } from "../src/lib/tournaments";

/** The draw is made under the tournament's row lock, as entering and taking out are (ADR 0059): a withdrawal and a draw at once, and two draws at once. Run on Postgres. */
let ownerId: number;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 20;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Player ${n}`, email: `f1p${n}@cup.my`, phone: `01351${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}
async function knockout(maxEntries: number) {
  const day = addDays(todayISO(), dayOffset++);
  const made = await createTournament(
    { venueId, name: `F1 Cup ${dayOffset}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 10, maxEntries, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: courts } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value.id;
}
beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues()).find((v) => v.courts.filter((c) => c.sport === "badminton").length >= 2)!;
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("the draw and a withdrawal at the same moment", () => {
  it("a withdrawal committed while the draw is being written never leaves a withdrawn entrant in a match", async () => {
    const id = await knockout(8);
    const entries: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await enter(await player(), id);
      if (!r.ok) throw new Error(r.error);
      entries.push(r.value.id);
    }
    // Hold the draw after it has read the entries and before it writes the first match.
    let atWrite!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((r) => (atWrite = r));
    const held = new Promise<void>((r) => (release = r));
    const db = getDb();
    const real = db.prepare.bind(db);
    let first = true;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const s = real(sql);
      if (!/INSERT INTO tournament_matches/.test(sql)) return s;
      return {
        ...s,
        run: async (...p: unknown[]) => {
          if (first) {
            first = false;
            atWrite();
            await held;
          }
          return s.run(...p);
        },
      };
    });
    const drawing = makeDraw(id);
    await inside;
    // The organiser's colleague takes the first entrant out (the tournament is still open: the draw is not committed).
    const outP = withdraw(entries[0]);
    await new Promise((r) => setTimeout(r, 1500));
    release();
    const [drawn] = await Promise.all([drawing, outP]);
    spy.mockRestore();
    expect(drawn.ok).toBe(true);
    const rows = (await db
      .prepare(
        `SELECT m.id FROM tournament_matches m JOIN tournament_entries e ON e.id IN (m.entry_a, m.entry_b)
          WHERE m.tournament_id = ? AND e.status = 'withdrawn' AND m.status = 'scheduled'`
      )
      .all(id)) as unknown[];
    // Intended: a withdrawn entrant is in no unplayed match (they are out; or the draw waited for the withdrawal).
    expect(rows.length).toBe(0);
  });

  it("two draws at once make one bracket", async () => {
    const id = await knockout(8);
    for (let i = 0; i < 4; i++) {
      const r = await enter(await player(), id);
      if (!r.ok) throw new Error(r.error);
    }
    const results = await Promise.all([makeDraw(id), makeDraw(id)]);
    const count = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id = ?").get(id)) as { n: number };
    // A 4-player knockout has 3 matches.
    expect(count.n).toBeLessThanOrEqual(4);
    expect(results.filter((r) => r.ok).length).toBe(1);
  });
});
