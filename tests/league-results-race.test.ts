import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { confirmResult, createLeague, decideResult, disputeResult, join, leagueDetail, reportResult, startSeason, type LeagueMatch } from "../src/lib/leagues";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Two people answering one league result at the same moment (migration 0177).
 *
 * Every change to a league match is one transaction on its locked row,
 * written only where the status and version are still what was read. Against
 * PGlite the calls interleave at every query; against a real Postgres server
 * (TEST_DATABASE_URL) they run on separate connections, which is where a read
 * then a write by id would let a correction overwrite a confirmation.
 */

const AT_ONCE = 8;
const today = todayISO();
let ownerId: number;
let venueId: number;
let n = 0;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Racer ${n}`, email: `race${n}@leagues.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** One box of six under way: fifteen matches, and whose account plays each side. */
async function box() {
  const made = await createLeague({ venueId, name: `Race Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null, fee: 0, boxSize: 6, startsOn: addDays(today, 1) }, ownerId);
  if (!made.ok) throw new Error(made.error);
  const users = new Map<number, User>();
  for (let i = 0; i < 6; i++) {
    const u = await player();
    const j = await join(u, made.value.id);
    if (!j.ok) throw new Error(j.error);
    users.set(j.value.id, u);
  }
  const s = await startSeason(made.value.id, { startsOn: today }, today);
  if (!s.ok) throw new Error(s.error);
  return { leagueId: made.value.id, matches: s.value.matches, users };
}

const now = async (leagueId: number, id: number): Promise<LeagueMatch> => (await leagueDetail(leagueId, { forStaff: true }))!.matches.find((m) => m.id === id)!;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
});

describe("one league result, answered at the same moment", () => {
  it("a correction racing the other side's confirmation: one of them stands, and a confirmed result is never turned back", async () => {
    const { leagueId, matches, users } = await box();
    for (const m of matches.slice(0, 6)) {
      const [a, b] = [users.get(m.a)!, users.get(m.b)!];
      const first = await reportResult(a.id, m.id, { winner: m.a, score: "21-10, 21-12" });
      if (!first.ok) throw new Error(first.error);
      const [corrected, confirmed] = await Promise.all([
        reportResult(a.id, m.id, { winner: m.a, score: "21-10, 21-18" }),
        confirmResult(b.id, m.id, { version: first.value.version }),
      ]);
      expect([corrected.ok, confirmed.ok].filter(Boolean)).toHaveLength(1);
      const after = await now(leagueId, m.id);
      if (confirmed.ok) expect(after).toMatchObject({ status: "confirmed", score: "21-10, 21-12" });
      else {
        expect(confirmed).toMatchObject({ code: "LG5_RESULT_CHANGED" });
        expect(after).toMatchObject({ status: "reported", score: "21-10, 21-18" });
      }
    }
  });

  it("staff deciding on what they saw while a player reports: one of them, never both", async () => {
    const { leagueId, matches, users } = await box();
    for (const m of matches.slice(0, 6)) {
      const shown = (await now(leagueId, m.id)).version;
      const [decided, reported] = await Promise.all([
        decideResult(m.id, ownerId, { winner: m.b, walkover: true }, { version: shown }),
        reportResult(users.get(m.a)!.id, m.id, { winner: m.a, score: "21-5, 21-5" }),
      ]);
      expect([decided.ok, reported.ok].filter(Boolean)).toHaveLength(1);
      expect(await now(leagueId, m.id)).toMatchObject(decided.ok ? { status: "walkover", winner: m.b } : { status: "reported", winner: m.a });
    }
  });

  it("many corrections and answers at once: at most one answer lands, and only on the result it saw", async () => {
    const { leagueId, matches, users } = await box();
    const m = matches[0];
    const [a, b] = [users.get(m.a)!, users.get(m.b)!];
    const first = await reportResult(a.id, m.id, { winner: m.a, score: "21-10, 21-12" });
    if (!first.ok) throw new Error(first.error);
    const results = await Promise.all(
      Array.from({ length: AT_ONCE }, (_, i) =>
        i % 3 === 0
          ? reportResult(a.id, m.id, { winner: m.a, score: `21-10, 21-${13 + i}` }).then((r) => ({ kind: "report" as const, r }))
          : i % 3 === 1
            ? confirmResult(b.id, m.id, { version: first.value.version }).then((r) => ({ kind: "confirm" as const, r }))
            : disputeResult(b.id, m.id, "That is not how it went", { version: first.value.version }).then((r) => ({ kind: "dispute" as const, r }))
      )
    );
    const answers = results.filter((x) => x.kind !== "report" && x.r.ok);
    expect(answers.length).toBeLessThanOrEqual(1);
    const after = await now(leagueId, m.id);
    if (answers.length === 1) {
      // The answer was to the first report, so nothing was corrected before it; a correction after it was refused.
      expect(after).toMatchObject({ status: answers[0].kind === "confirm" ? "confirmed" : "disputed", score: "21-10, 21-12" });
      expect(results.filter((x) => x.kind === "report" && x.r.ok)).toHaveLength(0);
    } else expect(after.status).toBe("reported");
  });
});
