/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { guardianEntrant, type Entrant } from "../src/lib/competition-entrants";
import { getDb } from "../src/lib/db";
import { answer, challenge, confirm, createLadder, decide, dispute, join, joinAs, ladderDetail, myPlaces, publicLadders, report, withdraw, type LadderInput } from "../src/lib/ladders";
import { addManaged } from "../src/lib/managed-people";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import sitemap from "../src/app/sitemap";
import * as ladderRoute from "../src/app/api/ladders/[id]/route";
import * as ladderList from "../src/app/api/ladders/route";

/**
 * A ladder's challenges are not public (docs/features/tournaments.md#club-ladders): the public sees the ranks, who is on the ladder
 * (by the names rule) and the confirmed results; never a challenge that is open or that ended any other way, who challenged whom
 * while it was open, a proposed time, a dispute note, or a booking. A player sees their own challenges and a manager sees all.
 */

let venueId: number;
let adminId: number;
let n = 0;
const manager = { adminId: null as number | null, name: "Musa Manager" };

type P = { user: User; id: number };

async function person(name = "Pub"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Player${n}`, email: `lp${n}@ladder-public.test`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${r.code ?? ""})`);
  return r.value;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  manager.adminId = adminId;
  venueId = (await listVenues())[0].id;
});

async function populated(count: number, over: Partial<LadderInput> = {}) {
  n++;
  const l = ok(await createLadder({ venueId, name: `Public Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, ...over }, adminId));
  const players: P[] = [];
  for (let i = 0; i < count; i++) {
    const user = await person();
    players.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
  }
  return { l, players };
}

const get = (id: number, query = "") => ladderRoute.GET(new NextRequest(`http://localhost/api/ladders/${id}${query}`), { params: Promise.resolve({ id: String(id) }) });

/** What must never be in the public view of a ladder, whatever state a challenge is in. */
const FORBIDDEN_KEYS = ["challenges", "challenger", "challenged", "proposedOn", "proposedMin", "proposedBy", "agreedOn", "agreedMin", "respondBy", "playBy", "awaiting", "disputeNote", "inChallenge", "reportedBy", "booking", "forfeit", "version", "events", "userId", "participantId", "atCounter", "contact"];
const FORBIDDEN_STATES = ["pending", "accepted", "reported", "disputed", "declined", "cancelled", "lapsed", "walkover", "void"];

function expectNothingOfChallenges(serialized: string, sentinels: string[]) {
  // The ladder's own scoring rules have words of their own ("void", "walkover"): they are not a challenge's state.
  const json = JSON.stringify(JSON.parse(serialized), (key, value) => (key === "rules" ? undefined : value));
  for (const key of FORBIDDEN_KEYS) expect(json, `key ${key}`).not.toContain(`"${key}"`);
  for (const state of FORBIDDEN_STATES) expect(json, `state ${state}`).not.toContain(`"${state}"`);
  for (const sentinel of sentinels) expect(json, sentinel).not.toContain(sentinel);
}

describe("a ladder's public view", () => {
  it("shows the ranks and the confirmed results, and nothing of a challenge in any other state", async () => {
    const { l, players } = await populated(12);
    const [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11] = players;
    const day = addDays(todayISO(), 6);
    const proposed = addDays(todayISO(), 7);
    const sentinels = [day, proposed, "SECRETNOTE-void", "SECRETNOTE-walk", "SECRETNOTE-open"];
    const play = async (a: P, b: P, challengerWins: boolean) => {
      const made = ok(await challenge(a.user.id, l.id, a.id, b.id));
      ok(await answer(b.user.id, made.id, { accept: true }));
      const reported = ok(await report(a.user.id, made.id, { winner: challengerWins ? a.id : b.id, score: challengerWins ? "21-10, 21-12" : "10-21, 12-21" }));
      return ok(await confirm(b.user.id, made.id, { version: reported.version }));
    };
    // Closed, in every way a challenge can end.
    await play(p1, p0, true);
    await play(p3, p2, false);
    const declined = ok(await challenge(p5.user.id, l.id, p5.id, p4.id));
    ok(await answer(p4.user.id, declined.id, { decline: true }));
    const cancelled = ok(await challenge(p7.user.id, l.id, p7.id, p6.id));
    ok(await withdraw(p7.user.id, cancelled.id));
    const struck = ok(await challenge(p9.user.id, l.id, p9.id, p8.id));
    ok(await answer(p8.user.id, struck.id, { accept: true }));
    const struckReport = ok(await report(p9.user.id, struck.id, { winner: p9.id, score: "21-10, 21-12" }));
    ok(await dispute(p8.user.id, struck.id, "SECRETNOTE-void", { version: struckReport.version }));
    ok(await decide(struck.id, manager, { void: true }, "Struck for the test"));
    const walk = ok(await challenge(p11.user.id, l.id, p11.id, p10.id));
    ok(await answer(p10.user.id, walk.id, { accept: true }));
    const walkReport = ok(await report(p11.user.id, walk.id, { winner: p11.id, score: "21-10, 21-12" }));
    ok(await dispute(p10.user.id, walk.id, "SECRETNOTE-walk", { version: walkReport.version }));
    ok(await decide(walk.id, manager, { winner: p10.id, walkover: true }, "Did not turn up"));
    const lapsed = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    ok(await answer(p3.user.id, lapsed.id, { accept: true }));
    await getDb().prepare("UPDATE ladder_challenges SET status = 'lapsed' WHERE id = ?").run(lapsed.id);
    // Open, in every state.
    const pending = ok(await challenge(p6.user.id, l.id, p6.id, p5.id, { onDate: proposed, minute: 19 * 60 }));
    const accepted = ok(await challenge(p8.user.id, l.id, p8.id, p7.id));
    ok(await answer(p7.user.id, accepted.id, { accept: true, onDate: day, minute: 18 * 60 }));
    const reportedOpen = ok(await challenge(p10.user.id, l.id, p10.id, p9.id));
    ok(await answer(p9.user.id, reportedOpen.id, { accept: true }));
    ok(await report(p10.user.id, reportedOpen.id, { winner: p10.id, score: "21-19, 21-19" }));
    const disputedOpen = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    ok(await answer(p3.user.id, disputedOpen.id, { accept: true }));
    const openReport = ok(await report(p4.user.id, disputedOpen.id, { winner: p4.id, score: "21-5, 21-5" }));
    ok(await dispute(p3.user.id, disputedOpen.id, "SECRETNOTE-open", { version: openReport.version }));

    const states = ((await getDb().prepare("SELECT DISTINCT status FROM ladder_challenges WHERE ladder_id = ?").all(l.id)) as { status: string }[]).map((r) => r.status).sort();
    expect(states).toEqual(["accepted", "cancelled", "confirmed", "declined", "disputed", "lapsed", "pending", "reported", "void", "walkover"]);

    // The library's public view.
    const view = (await ladderDetail(l.id))!;
    expect(view.challenges).toBeUndefined();
    expect(view.rows.map((r) => r.playerId)).toEqual([p1.id, p0.id, p2.id, p3.id, p4.id, p5.id, p6.id, p7.id, p8.id, p9.id, p10.id, p11.id]);
    expect(view.rows.every((r) => r.inChallenge === undefined)).toBe(true);
    // Two confirmed results, newest first; the score is the winner's games first, whichever side challenged.
    expect(view.results).toHaveLength(2);
    expect(view.results.map((r) => [r.winnerName, r.loserName, r.score])).toEqual([
      [p2.user.name, p3.user.name, "21-10, 21-12"],
      [p1.user.name, p0.user.name, "21-10, 21-12"],
    ]);
    expectNothingOfChallenges(JSON.stringify(view), sentinels);

    // The public API, signed out: the same, and nothing for a person who is not there.
    const res = await get(l.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mine).toEqual([]);
    expect(body.ladder.results).toHaveLength(2);
    expectNothingOfChallenges(JSON.stringify(body), sentinels);
    // An earlier season's page is the same shape.
    expectNothingOfChallenges(JSON.stringify(await (await get(l.id, "?season=1")).json()), sentinels);

    // A player sees their own challenges (and their guardian's): the open ones and their history.
    const mineP6 = (await myPlaces(p6.user.id, l.id))[0];
    expect(mineP6.open.map((c) => [c.id, c.status, c.proposedOn])).toEqual([[pending.id, "pending", proposed]]);
    expect(mineP6.history.map((c) => c.status)).toEqual(["cancelled"]);
    const mineP3 = (await myPlaces(p3.user.id, l.id))[0];
    expect(mineP3.open.map((c) => c.status).sort()).toEqual(["disputed"]);
    expect(mineP3.history.map((c) => c.status).sort()).toEqual(["confirmed", "lapsed"]);
    expect((await myPlaces(p8.user.id, l.id))[0].open.map((c) => c.status)).toEqual(["accepted"]);
    // Somebody who is not on the ladder sees none.
    expect(await myPlaces((await person()).id, l.id)).toEqual([]);

    // A manager sees all of it, as before: every state, the dispute notes and who is in a challenge.
    const staff = (await ladderDetail(l.id, { forStaff: true }))!;
    expect([...new Set(staff.challenges!.map((c) => c.status))].sort()).toEqual(states);
    expect(staff.challenges!.find((c) => c.id === disputedOpen.id)!.disputeNote).toBe("SECRETNOTE-open");
    expect(staff.rows.find((r) => r.playerId === p6.id)!.inChallenge).toBe(true);
    expect(staff.rows.find((r) => r.playerId === p0.id)!.inChallenge).toBe(false);
    expect(staff.results).toHaveLength(2);
    expect(staff.events!.length).toBeGreaterThan(0);
  });

  it("shows a result struck or changed by the venue as it now stands, and none that was never confirmed", async () => {
    const { l, players } = await populated(3);
    const [, p1, p2] = players;
    const made = ok(await challenge(p2.user.id, l.id, p2.id, p1.id));
    ok(await answer(p1.user.id, made.id, { accept: true }));
    const reported = ok(await report(p2.user.id, made.id, { winner: p2.id, score: "21-10, 21-12" }));
    // Reported, not confirmed: nothing public yet.
    expect((await ladderDetail(l.id))!.results).toEqual([]);
    ok(await confirm(p1.user.id, made.id, { version: reported.version }));
    expect((await ladderDetail(l.id))!.results).toHaveLength(1);
    // The venue corrects it to the other side's win: the public result follows.
    ok(await decide(made.id, manager, { winner: p1.id, score: "10-21, 12-21" }, "The wrong side was reported"));
    expect((await ladderDetail(l.id))!.results.map((r) => [r.winnerName, r.loserName, r.score])).toEqual([[p1.user.name, p2.user.name, "21-10, 21-12"]]);
    // And struck: no result at all.
    ok(await decide(made.id, manager, { void: true }, "Struck"));
    expect((await ladderDetail(l.id))!.results).toEqual([]);
  });

  it("names the people by the names rule: a junior ladder's result by first name and initial, never a child's full name", async () => {
    const l = ok(await createLadder({ venueId, name: `Junior Public ${++n}`, sport: "badminton", teamSize: 1, level: null, audience: "juniors" }, adminId));
    const mum = await person("Mum");
    const dad = await person("Dad");
    const kidA = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    const kidB = await addManaged(dad.id, { displayName: "Ben Tan", relationship: "parent", authority: true }, dad.name);
    if (!kidA.ok || !kidB.ok) throw new Error("kids");
    const a = ok(await joinAs((await guardianEntrant(mum, kidA.person.id)) as Entrant, l.id));
    const b = ok(await joinAs((await guardianEntrant(dad, kidB.person.id)) as Entrant, l.id));
    // An open challenge between two children is nobody's business but theirs and their guardians'.
    const open = ok(await challenge(dad.id, l.id, b.playerId, a.playerId, { onDate: addDays(todayISO(), 9) }));
    let json = JSON.stringify(await (await get(l.id)).json());
    expect(json).toContain("Aina L.");
    expect(json).toContain("Ben T.");
    expect(json).not.toContain(open.id.toString() + ",");
    expectNothingOfChallenges(json, [addDays(todayISO(), 9)]);
    // Decided: the result is public, by first name and initial.
    ok(await answer(mum.id, open.id, { accept: true }));
    const reported = ok(await report(dad.id, open.id, { winner: b.playerId, score: "21-10, 21-12" }));
    ok(await confirm(mum.id, open.id, { version: reported.version }));
    const view = (await ladderDetail(l.id))!;
    expect(view.results.map((r) => [r.winnerName, r.loserName, r.score])).toEqual([["Ben T.", "Aina L.", "21-10, 21-12"]]);
    json = JSON.stringify(await (await get(l.id)).json());
    for (const leak of ["Binti Lim", "Ben Tan", "Aina Binti", mum.name, dad.name, mum.phone, dad.phone, mum.email]) expect(json, leak).not.toContain(leak);
    expectNothingOfChallenges(json, []);
  });

  it("lists ladders with no count or sign of challenges, and the sitemap names no ladder", async () => {
    const { l, players } = await populated(3);
    ok(await challenge(players[1].user.id, l.id, players[1].id, players[0].id));
    const list = await publicLadders();
    const mine = list.find((x) => x.id === l.id)!;
    expect(mine.players).toBe(3);
    expect(JSON.stringify(list)).not.toMatch(/challenge|inChallenge|pending/i);
    const res = await ladderList.GET(new NextRequest("http://localhost/api/ladders"));
    expect(JSON.stringify(await res.json())).not.toMatch(/challenge|pending/i);
    expect((await sitemap()).some((e) => e.url.includes("/ladders"))).toBe(false);
  });

  it("answers 404 for a ladder that is not there, as it did", async () => {
    const res = await get(999999);
    expect(res.status).toBe(404);
  });
});
