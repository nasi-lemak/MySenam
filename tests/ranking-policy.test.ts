import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { DICTIONARIES } from "../src/lib/i18n";
import { STAFF_DICTIONARIES } from "../src/lib/staff-i18n";
import { addManaged } from "../src/lib/managed-people";
import { saveProfile } from "../src/lib/player-profiles";
import type { RatingFormat } from "../src/lib/rating-math";
import {
  boardChoices,
  businessBoard,
  currentStanding,
  earnedRatingsOf,
  myRatings,
  poolEarned,
  ratingPolicyLog,
  rankingPolicy,
  rankingsPublished,
  recomputePool,
  setBusinessBoard,
  setRankingPolicy,
  staffRatings,
  venueBoard,
} from "../src/lib/ratings";
import { managerOnly } from "../src/lib/roles";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import sitemap from "../src/app/sitemap";
import RankingsLayout from "../src/app/venue/[id]/rankings/layout";
import * as adminRatings from "../src/app/api/admin/ratings/route";
import * as publicRankings from "../src/app/api/venues/[id]/rankings/route";

/**
 * A venue's ranking policy (migration 0275, ADR 0034; lib/ratings.ts `rankingPolicy`): public rankings are off until a manager switches
 * them on, the provisional section and the number of counted results before a player is ranked are the venue's, every public surface
 * obeys the switch, the private views never do, and every change is logged. The pools here are written straight into the ledger
 * (`rated_results`, the source of truth) so that exactly N counted results are easy to have; the replay is what makes the ratings.
 */

const today = todayISO();
let n = 0;
let seq = 0;
let managerCookie: string;
let deskCookie: string;

async function adult(name: string, listed = true): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `rk${n}@policy.test`, phone: `01390${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  const saved = await saveProfile(made.user.id, listed ? { adult: true, rankPublicly: true, rankName: `${name} Ranked` } : { adult: true });
  if (!saved.ok) throw new Error(saved.error);
  return made.user;
}

type Subject = { kind: "user" | "participant" | "team"; id: number; label?: string };

/** One decided match, written into the ledger as a tournament's would be (a made-up event number, so nothing re-reads it). */
async function seed(venueId: number, sport: string, format: RatingFormat, a: Subject[], b: Subject[], outcome: 0 | 0.5 | 1, kind: "played" | "walkover" | "retired" = "played") {
  seq++;
  const db = getDb();
  const day = addDays(today, -600 + seq);
  const made = (await db
    .prepare(
      `INSERT INTO rated_results (venue_id, sport, format, source_kind, source_id, source_match, unit_no, event_name, played_on, play_order, outcome, kind, margin, fact_hash)
       VALUES (?, ?, ?, 'tournament', ?, ?, 0, 'Seeded Cup', ?, ?, ?, ?, NULL, ?) RETURNING id`
    )
    .get(venueId, sport, format, 9_000_000 + venueId, seq, day, seq, outcome, kind, `seed${seq}`)) as { id: number };
  for (const [side, list] of [["a", a], ["b", b]] as const)
    for (const s of list) await db.prepare("INSERT INTO rated_result_subjects (result_id, side, subject_kind, subject_id, label) VALUES (?, ?, ?, ?, ?)").run(made.id, side, s.kind, s.id, s.label ?? "");
  return made.id;
}

const U = (u: User): Subject => ({ kind: "user", id: u.id, label: u.name });

/** `who` plays `count` counted matches against the fillers, winning two in three. */
async function play(venueId: number, who: Subject, fillers: Subject[], count: number, sport = "badminton", format: RatingFormat = "singles") {
  for (let i = 0; i < count; i++) await seed(venueId, sport, format, [who], [fillers[i % fillers.length]], i % 3 === 2 ? 0 : 1);
}

async function venue(name: string) {
  const made = await createVenue({ name, area: "Petaling Jaya", address: "1 Jalan Test", phone: "0312345678" });
  if (!made.ok) throw new Error(made.error);
  return made.venue.id;
}

/** Everything the replay wrote, as a manager could compare it before and after something that must not touch it. */
async function ledgerSnapshot(venueId: number) {
  const db = getDb();
  return {
    results: await db
      .prepare("SELECT id, fact_hash, voided_at, weight, margin_factor, side_a_rating, side_b_rating, expected_a FROM rated_results WHERE venue_id = ? ORDER BY id")
      .all(venueId),
    subjects: await db
      .prepare(
        `SELECT s.id, s.rating_before, s.rating_after, s.k, s.games_before FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id WHERE r.venue_id = ? ORDER BY s.id`
      )
      .all(venueId),
    standings: await db.prepare("SELECT sport, format, subject_kind, subject_id, rating, games, wins, draws, losses FROM rating_subjects WHERE venue_id = ? ORDER BY sport, format, subject_kind, subject_id").all(venueId),
  };
}

const call = (method: "GET" | "POST", cookie: string, body?: unknown, query = "") =>
  (method === "GET" ? adminRatings.GET : adminRatings.POST)(
    new NextRequest(`http://localhost/api/admin/ratings${method === "GET" ? query : ""}`, { method, headers: { cookie }, ...(body ? { body: JSON.stringify(body) } : {}) })
  );

const publicGet = (venueId: number, query = "") =>
  publicRankings.GET(new NextRequest(`http://localhost/api/venues/${venueId}/rankings${query}`), { params: Promise.resolve({ id: String(venueId) }) });

let V: number;
const fillers: Subject[] = [];
let p6: User;
let p7: User;
let p8: User;
let p9: User;
let quiet: User;
let kid: number;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  V = await venue("Policy Arena");
  const manager = await createAdmin({ name: "Mira Manager", email: "mira-rk@venue.my", password: "manager-pass-1", venueId: V });
  const desk = await createAdmin({ name: "Dev Desk", email: "dev-rk@venue.my", password: "desk-password-1", venueId: V, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  for (let i = 0; i < 4; i++) fillers.push(U(await adult("Filler", false)));
  p6 = await adult("Sixer");
  p7 = await adult("Seven");
  p8 = await adult("Eight");
  p9 = await adult("Nine");
  quiet = await adult("Quiet", false);
  // A child a guardian manages, with plenty of results: never listed, however many.
  const mum = await adult("Mum");
  const made = await addManaged(mum.id, { displayName: "Aina Secret", relationship: "parent", authority: true, birthYear: new Date().getFullYear() - 10 }, mum.name);
  if (!made.ok) throw new Error(made.error);
  kid = made.person.id;
  await play(V, U(p6), fillers, 6);
  await play(V, U(p7), fillers, 7);
  await play(V, U(p8), fillers, 8);
  await play(V, U(p9), fillers, 9);
  await play(V, U(quiet), fillers, 12);
  await play(V, { kind: "participant", id: kid, label: "" }, fillers, 12);
  await recomputePool(V, "badminton", "singles");
});

describe("public rankings are off until a manager switches them on", () => {
  it("has them off by default, with the install's number of counted results before a player is ranked", async () => {
    expect(await rankingPolicy(V)).toMatchObject({ publicRankings: false, showProvisional: false, rankAfter: 8, installDefault: 8, custom: false });
    // A venue with no settings row at all, as every existing venue is after the migration: off.
    const other = await venue("No Row Arena");
    expect(await rankingPolicy(other)).toMatchObject({ publicRankings: false, showProvisional: false, rankAfter: 8, custom: false });
    expect(await getDb().prepare("SELECT 1 AS x FROM venue_rating_settings WHERE venue_id = ?").get(other)).toBeFalsy();
  });

  it("answers 404, not an empty page, on every public surface while off, though a great deal is rated", async () => {
    expect((await boardChoices(V)).pools).toEqual([{ sport: "badminton", format: "singles" }]);
    for (const query of ["", "?sport=badminton&format=singles", "?sport=badminton&format=singles&scope=business", "?sport=badminton&format=singles&season=2026"]) {
      const res = await publicGet(V, query);
      expect(res.status, query).toBe(404);
      expect(await res.json()).toEqual({ error: "This venue has not published rankings." });
    }
    // The venue page's link, and the page itself.
    expect(await rankingsPublished(V)).toBe(false);
    await expect(RankingsLayout({ children: null, params: Promise.resolve({ id: String(V) }) })).rejects.toMatchObject({ digest: expect.stringMatching(/NOT_FOUND|404/) });
    // Nothing lists it for search engines, off or on.
    expect((await sitemap()).map((e) => e.url).filter((u) => u.includes("/rankings"))).toEqual([]);
  });

  it("leaves every private view as it was: the player's, the manager's panel, the history", async () => {
    const mine = await myRatings(p8.id);
    expect(mine.who[0].pools[0]).toMatchObject({ sport: "badminton", format: "singles", games: 8, provisional: false });
    expect((await myRatings(p7.id)).who[0].pools[0]).toMatchObject({ games: 7, provisional: true, rankAfter: 8 });
    const panel = await staffRatings(V);
    expect(panel.policy).toMatchObject({ publicRankings: false });
    expect(panel.hasRated).toBe(true);
    // A manager sees everybody, the provisional ones too, public or not.
    const subjects = panel.pools[0].subjects;
    expect(subjects.find((s) => s.id === p7.id)).toMatchObject({ provisional: true, games: 7 });
    expect(subjects.find((s) => s.id === p9.id)).toMatchObject({ provisional: false, games: 9 });
    expect(subjects.find((s) => s.id === kid)).toMatchObject({ kind: "participant", label: "(junior player)" });
    expect((await call("GET", managerCookie, undefined, `?venueId=${V}`)).status).toBe(200);
  });

  it("is switched on by a manager, who is logged; the desk is refused", async () => {
    expect(managerOnly("POST", "/api/admin/ratings")).toBe(true);
    expect((await call("POST", deskCookie, { venueId: V, action: "policy", publicRankings: true })).status).toBe(403);
    expect((await call("GET", deskCookie, undefined, `?venueId=${V}&export=ledger`)).status).toBe(403);
    expect(await rankingPolicy(V)).toMatchObject({ publicRankings: false });
    const res = await call("POST", managerCookie, { venueId: V, action: "policy", publicRankings: true });
    expect(res.status).toBe(200);
    expect(await rankingPolicy(V)).toMatchObject({ publicRankings: true, updatedBy: "Mira Manager" });
    expect((await res.json()).ratings.policy.publicRankings).toBe(true);
    // Who, when, from what to what: in the policy log and in the activity log.
    expect((await ratingPolicyLog(V))[0]).toMatchObject({ kind: "public_rankings", from: "off", to: "on", by: "Mira Manager" });
    expect((await ratingPolicyLog(V))[0].at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect((await listActivity([V], { limit: 20 })).map((a) => a.action)).toContain("ratings.public_rankings");
    // Saying what it already is changes and logs nothing.
    const before = (await ratingPolicyLog(V)).length;
    expect((await call("POST", managerCookie, { venueId: V, action: "policy", publicRankings: true })).status).toBe(200);
    expect((await ratingPolicyLog(V)).length).toBe(before);
  });

  it("then answers on every public surface, ranking only those who chose to be listed and have enough counted results", async () => {
    expect(await rankingsPublished(V)).toBe(true);
    const element = await RankingsLayout({ children: "page", params: Promise.resolve({ id: String(V) }) });
    expect(element).toBeTruthy();
    const choices = await publicGet(V);
    expect(choices.status).toBe(200);
    expect((await choices.json()).rules).toEqual({ provisionalGames: 8, rankAfter: 8, showProvisional: false });
    const res = await publicGet(V, "?sport=badminton&format=singles");
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.board.rows.map((r: { name: string }) => r.name);
    expect(names.sort()).toEqual(["Eight Ranked", "Nine Ranked"]);
    expect(body.board.rankAfter).toBe(8);
    expect(body.board.provisional).toEqual([]);
    // Not the one who never opted in, whatever they played, and not a child.
    expect(JSON.stringify(body)).not.toContain("Quiet");
    expect(JSON.stringify(body)).not.toContain("Aina");
    expect(JSON.stringify(body)).not.toContain("Seven");
    expect(JSON.stringify(body)).not.toContain("Sixer");
  });

  it("goes back to 404 when it is switched off, and takes the provisional section with it", async () => {
    expect((await setRankingPolicy(V, { showProvisional: true }, "Mira Manager")).ok).toBe(true);
    expect((await setRankingPolicy(V, { publicRankings: false }, "Mira Manager")).ok).toBe(true);
    expect(await rankingPolicy(V)).toMatchObject({ publicRankings: false, showProvisional: false });
    expect((await publicGet(V, "?sport=badminton&format=singles")).status).toBe(404);
    expect(await rankingsPublished(V)).toBe(false);
    // The provisional section needs public rankings on.
    expect(await setRankingPolicy(V, { showProvisional: true }, "Mira Manager")).toMatchObject({ ok: false, code: "RT_PROVISIONAL_NEEDS_PUBLIC", status: 409 });
    const log = (await ratingPolicyLog(V)).map((l) => `${l.kind}:${l.from}>${l.to}`);
    expect(log).toContain("show_provisional:off>on");
    expect(log).toContain("show_provisional:on>off");
    expect(log).toContain("public_rankings:on>off");
    expect((await setRankingPolicy(V, { publicRankings: true }, "Mira Manager")).ok).toBe(true);
  });
});

describe("the provisional section and the number of counted results before a player is ranked", () => {
  it("ranks a player from the venue's number of counted results: 7, 8 and 9 around the default, and any of 3 to 30", async () => {
    // Listed, with 6, 7, 8 and 9 counted results each; public rankings are on.
    const ranked = async () => (await venueBoard(V, "badminton", "singles"))!.rows.map((r) => r.name).sort();
    const named = (u: User) => `${u.name.split(" ")[0]} Ranked`;
    expect(await ranked()).toEqual([named(p8), named(p9)].sort());
    const expectations: [number, User[]][] = [
      [3, [p6, p7, p8, p9]],
      [6, [p6, p7, p8, p9]],
      [7, [p7, p8, p9]],
      [8, [p8, p9]],
      [9, [p9]],
      [10, []],
      [30, []],
    ];
    for (const [after, who] of expectations) {
      expect((await setRankingPolicy(V, { rankAfter: after }, "Mira Manager")).ok).toBe(true);
      expect(await ranked(), `ranked after ${after}`).toEqual(who.map(named).sort());
      expect((await rankingPolicy(V)).rankAfter).toBe(after);
    }
    // Back to the install's default, which is what "default" means.
    expect((await setRankingPolicy(V, { rankAfter: null }, "Mira Manager")).ok).toBe(true);
    expect(await rankingPolicy(V)).toMatchObject({ rankAfter: 8, custom: false });
  });

  it("refuses a number outside 3 to 30, and a provisional section without public rankings", async () => {
    for (const bad of [2, 31, 0, -1, 7.5, Number.NaN]) expect(await setRankingPolicy(V, { rankAfter: bad }, "Mira Manager"), String(bad)).toMatchObject({ ok: false, code: "RT_RANK_AFTER", status: 400 });
    const res = await call("POST", managerCookie, { venueId: V, action: "policy", rankAfter: 31 });
    expect(res.status).toBe(400);
    expect((await call("POST", managerCookie, { venueId: V, action: "policy", rankAfter: "many" })).status).toBe(400);
    expect((await call("POST", managerCookie, { venueId: V, action: "policy", publicRankings: "yes" })).status).toBe(400);
    expect((await call("POST", managerCookie, { venueId: V, action: "policy" })).status).toBe(400);
    expect(await rankingPolicy(V)).toMatchObject({ rankAfter: 8, custom: false });
    expect((await setRankingPolicy(V, { rankAfter: 3 }, "Mira Manager")).ok).toBe(true);
    expect((await setRankingPolicy(V, { rankAfter: 30 }, "Mira Manager")).ok).toBe(true);
    expect((await setRankingPolicy(V, { rankAfter: null }, "Mira Manager")).ok).toBe(true);
  });

  it("shows the others apart, never ranked and in no order of merit, only if the venue chose to", async () => {
    expect((await venueBoard(V, "badminton", "singles"))!.provisional).toEqual([]);
    expect((await call("POST", managerCookie, { venueId: V, action: "policy", showProvisional: true })).status).toBe(200);
    const board = (await venueBoard(V, "badminton", "singles"))!;
    // Default 8: the ones with 6 and 7 counted results are provisional; 8 and 9 are ranked.
    expect(board.provisional!.map((r) => r.name)).toEqual(["Seven Ranked", "Sixer Ranked"]);
    expect(board.provisional!.map((r) => r.games)).toEqual([7, 6]);
    // No rank, and listed by name (Seven comes before Sixer though Sixer's rating may be the higher): not an order of merit.
    for (const r of board.provisional!) expect(Object.keys(r).sort()).toEqual(["games", "kind", "name", "rating"]);
    expect(board.rows.every((r) => r.rank >= 1)).toBe(true);
    expect(board.rows.map((r) => r.name)).not.toContain("Seven Ranked");
    // The API says so, too, with the number.
    const body = await (await publicGet(V, "?sport=badminton&format=singles")).json();
    expect(body.rules).toEqual({ provisionalGames: 8, rankAfter: 8, showProvisional: true });
    expect(body.board.provisional).toHaveLength(2);
    // Never the one who did not opt in, and never a child, whatever the number.
    for (const after of [3, 8, 30, null]) {
      expect((await setRankingPolicy(V, { rankAfter: after }, "Mira Manager")).ok).toBe(true);
      const text = JSON.stringify(await (await publicGet(V, "?sport=badminton&format=singles")).json());
      expect(text, `after ${after}`).not.toContain("Quiet");
      expect(text, `after ${after}`).not.toContain("Aina");
      expect(text, `after ${after}`).not.toContain('"name":""');
    }
    // At 30 nobody is ranked: all four listed people are provisional, none ranked.
    await setRankingPolicy(V, { rankAfter: 30 }, "Mira Manager");
    const none = (await venueBoard(V, "badminton", "singles"))!;
    expect(none.rows).toEqual([]);
    expect(none.provisional!.map((r) => r.name)).toEqual(["Eight Ranked", "Nine Ranked", "Seven Ranked", "Sixer Ranked"]);
    await setRankingPolicy(V, { rankAfter: null }, "Mira Manager");
  });

  it("re-classes people and nothing else: no ledger row, no rating moves, and a fresh recompute is the same", async () => {
    const before = await ledgerSnapshot(V);
    for (const after of [3, 30, 5, null]) {
      await setRankingPolicy(V, { rankAfter: after }, "Mira Manager");
      expect(await ledgerSnapshot(V), `after ${after}`).toEqual(before);
    }
    await recomputePool(V, "badminton", "singles");
    expect(await ledgerSnapshot(V)).toEqual(before);
    // Provisional or not follows the venue's number, for the private views too.
    await setRankingPolicy(V, { rankAfter: 7 }, "Mira Manager");
    expect((await myRatings(p7.id)).who[0].pools[0]).toMatchObject({ provisional: false, rankAfter: 7 });
    expect(await currentStanding(V, "badminton", "singles", "user", p7.id)).toMatchObject({ provisional: false });
    expect((await staffRatings(V)).pools[0].subjects.find((s) => s.id === p6.id)).toMatchObject({ provisional: true });
    await setRankingPolicy(V, { rankAfter: null }, "Mira Manager");
    expect((await myRatings(p7.id)).who[0].pools[0]).toMatchObject({ provisional: true, rankAfter: 8 });
  });

  it("uses the same threshold for matching on an earned level: only the right venue's number, only the right pool", async () => {
    const other = await venue("Second Arena");
    await play(other, U(p7), fillers, 7);
    await recomputePool(other, "badminton", "singles");
    // At the default 8 neither pool of p7's (7 results each) is earned.
    expect([...(await earnedRatingsOf(p7.id)).keys()]).toEqual([]);
    expect((await poolEarned(V, "badminton", "singles")).has(p7.id)).toBe(false);
    // The first venue lowers its number: its pool is earned for p7, the second venue's still is not.
    await setRankingPolicy(V, { rankAfter: 7 }, "Mira Manager");
    expect([...(await earnedRatingsOf(p7.id)).keys()]).toEqual([`${V}|badminton|singles`]);
    expect((await poolEarned(V, "badminton", "singles")).has(p7.id)).toBe(true);
    expect((await poolEarned(other, "badminton", "singles")).has(p7.id)).toBe(false);
    await setRankingPolicy(V, { rankAfter: null }, "Mira Manager");
  });
});

describe("the business-wide board needs the branch's allowance and its switch", () => {
  it("lists a branch only if it allows it and has published its own rankings; never a provisional section", async () => {
    const a = await venue("Branch A");
    const b = await venue("Branch B");
    const biz = (await getDb().prepare("INSERT INTO businesses (name) VALUES ('Policy Group') RETURNING id").get()) as { id: number };
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(biz.id, a, b);
    const ana = await adult("Ana");
    const bob = await adult("Bob");
    await play(a, U(ana), fillers, 9);
    await play(b, U(bob), fillers, 9);
    await recomputePool(a, "badminton", "singles");
    await recomputePool(b, "badminton", "singles");
    await setBusinessBoard(a, true);
    await setBusinessBoard(b, true);
    const names = async () => (await businessBoard(a, "badminton", "singles"))!.rows.map((r) => r.name).sort();
    // Neither has published: neither is listed, whoever allowed the business board.
    expect(await names()).toEqual([]);
    expect((await publicGet(a, "?sport=badminton&format=singles&scope=business")).status).toBe(404);
    await setRankingPolicy(a, { publicRankings: true, showProvisional: true }, "A's Manager");
    expect(await names()).toEqual(["Ana Ranked"]);
    // B has not published: its players are not on A's board, whatever A's manager does.
    expect(await names()).not.toContain("Bob Ranked");
    await setRankingPolicy(b, { publicRankings: true }, "B's Manager");
    expect(await names()).toEqual(["Ana Ranked", "Bob Ranked"]);
    const res = await publicGet(a, "?sport=badminton&format=singles&scope=business");
    expect(res.status).toBe(200);
    expect((await res.json()).board.provisional).toEqual([]);
    // A branch that does not allow the business board is left out, public or not.
    await setBusinessBoard(b, false);
    expect(await names()).toEqual(["Ana Ranked"]);
    await getDb().prepare("UPDATE venues SET business_id = NULL WHERE id IN (?, ?)").run(a, b);
  });
});

describe("who changed what: the policy log", () => {
  it("records each part that changes with who, from, to and when, and an event marked rated with who marked it", async () => {
    const w = await venue("Logged Arena");
    expect((await setRankingPolicy(w, { publicRankings: true, showProvisional: true, rankAfter: 12 }, "Wan Manager")).ok).toBe(true);
    expect((await setRankingPolicy(w, { rankAfter: null }, "Lee Manager")).ok).toBe(true);
    const log = await ratingPolicyLog(w);
    expect(log.map((l) => [l.kind, l.from, l.to, l.by])).toEqual([
      ["rank_after", "12", "default", "Lee Manager"],
      ["rank_after", "default", "12", "Wan Manager"],
      ["show_provisional", "off", "on", "Wan Manager"],
      ["public_rankings", "off", "on", "Wan Manager"],
    ]);
    expect(await rankingPolicy(w)).toMatchObject({ updatedBy: "Lee Manager" });
    // The manager's panel carries it.
    expect((await staffRatings(w)).policyLog!.length).toBe(4);
  });

  it("logs through the dashboard too, in the activity log, one entry for each part", async () => {
    await setRankingPolicy(V, { showProvisional: false, rankAfter: null }, "Mira Manager");
    const before = (await listActivity([V], { limit: 200 })).filter((a) => a.action.startsWith("ratings.")).length;
    expect((await call("POST", managerCookie, { venueId: V, action: "policy", showProvisional: true, rankAfter: 5 })).status).toBe(200);
    const actions = (await listActivity([V], { limit: 200 })).map((a) => a.action);
    expect(actions.filter((a) => a.startsWith("ratings.")).length).toBe(before + 2);
    expect(actions).toContain("ratings.rank_after");
    await call("POST", managerCookie, { venueId: V, action: "policy", rankAfter: null });
  });
});

describe("the ledger as a spreadsheet, for a manager", () => {
  it("lists every result with each rating before and after, what counted and why not, replaced rows marked, and nothing of a child's name", async () => {
    const w = await venue("Export Arena");
    const x = await adult("Xan");
    const y = await adult("Yara");
    const z = await adult("Zed");
    const mum = await adult("Mum2");
    const made = await addManaged(mum.id, { displayName: "Kiddo Hidden", relationship: "parent", authority: true, birthYear: new Date().getFullYear() - 9 }, mum.name);
    if (!made.ok) throw new Error(made.error);
    const child: Subject = { kind: "participant", id: made.person.id, label: "" };
    await seed(w, "badminton", "singles", [U(x)], [U(y)], 1);
    await seed(w, "badminton", "singles", [U(y)], [U(z)], 0);
    await seed(w, "badminton", "singles", [U(x)], [U(z)], 1, "walkover");
    await seed(w, "badminton", "singles", [child], [U(x)], 1, "retired");
    const voided = await seed(w, "badminton", "singles", [U(z)], [U(y)], 1);
    await getDb().prepare("UPDATE rated_results SET voided_at = datetime('now'), voided_reason = 'result_changed' WHERE id = ?").run(voided);
    await seed(w, "badminton", "doubles", [U(x), U(y)], [U(z), child], 1);
    await recomputePool(w, "badminton", "singles");
    await recomputePool(w, "badminton", "doubles");
    const res = await call("GET", managerCookie, undefined, `?venueId=${V}&export=ledger`);
    // Another venue's manager cannot read this venue's ledger.
    expect((await call("GET", managerCookie, undefined, `?venueId=${w}&export=ledger`)).status).toBe(403);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("rating-ledger-venue-");
    // As the venue's own manager would read it: use the library the route uses, for the venue we seeded.
    const { ledgerCsv } = await import("../src/lib/ratings");
    const csv = await ledgerCsv(w);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    const cells = (line: string) => line.slice(1, -1).split('","');
    const header = cells(lines[0]);
    expect(header).toEqual(expect.arrayContaining(["Rating before", "Rating after", "Change", "Counted", "Why not counted", "Ledger row"]));
    const rows = lines.slice(1).map((l) => Object.fromEntries(cells(l).map((c, i) => [header[i], c])));
    // One line for each person on each result: 4 singles results x 2 + the voided 2 + the doubles' 4.
    expect(rows).toHaveLength(2 + 2 + 2 + 2 + 2 + 4);
    expect(csv).not.toContain("Kiddo");
    expect(rows.some((r) => r["Player or team"] === "(junior player)")).toBe(true);
    // The walkover moves nothing and says so; the voided row is marked, with why, and carries no ratings.
    const walk = rows.filter((r) => r["How decided"] === "walkover");
    expect(walk.every((r) => r.Counted === "no" && r["Why not counted"] === "walkover: moves nothing" && r.Change === "0")).toBe(true);
    const gone = rows.filter((r) => r["Ledger row"] === "voided");
    expect(gone).toHaveLength(2);
    expect(gone.every((r) => r["Rating before"] === "" && r["Why not counted"].startsWith("replaced or struck: result_changed"))).toBe(true);
    // Ratings before and after agree with what the replay stored.
    const stored = (await getDb()
      .prepare("SELECT s.subject_id, s.rating_before, s.rating_after FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id WHERE r.id = ? ORDER BY s.id")
      .all(Number(rows[0].Result))) as { rating_before: string; rating_after: string }[];
    const mine = rows.filter((r) => r.Result === rows[0].Result);
    expect(mine.map((r) => Number(r["Rating before"]))).toEqual(stored.map((s) => Number(s.rating_before)));
    expect(mine.map((r) => Number(r["Rating after"]))).toEqual(stored.map((s) => Number(s.rating_after)));
    // A pool of it.
    const only = (await ledgerCsv(w, { sport: "badminton", format: "doubles" })).replace(/^﻿/, "").trim().split("\r\n");
    expect(only).toHaveLength(1 + 4);
  });

  it("is logged, and refused for the desk", async () => {
    expect((await call("GET", managerCookie, undefined, `?venueId=${V}&export=ledger&sport=badminton&format=singles`)).status).toBe(200);
    expect((await call("GET", managerCookie, undefined, `?venueId=${V}&export=ledger&sport=nonsense`)).status).toBe(400);
    const actions = await listActivity([V], { limit: 200 });
    expect(actions.map((a) => a.action)).toContain("ratings.ledger_exported");
  });
});

describe("what is said: an estimate from the results counted, in every language", () => {
  it("says a rating is an estimate and that N results do not make it exact, and that provisional ratings may move a lot", () => {
    for (const l of ["en", "ms", "zh", "ta"] as const) {
      const d = DICTIONARIES[l] as Record<string, string>;
      for (const key of ["rk1.note", "rk1.provisional.title", "rk1.provisional.intro", "rk1.provisional.caption", "rk1.venueSets", "err.RT_RANK_AFTER", "err.RT_PROVISIONAL_NEEDS_PUBLIC"]) {
        expect(d[key], `${l} ${key}`).toBeTruthy();
      }
      expect(d["rk1.note"], l).toContain("{n}");
      expect(d["rk1.provisional.title"], l).toContain("{n}");
    }
    const en = DICTIONARIES.en as Record<string, string>;
    expect(en["rk1.note"]).toMatch(/estimate/);
    expect(en["rk1.note"]).toMatch(/do not make it exact/);
    expect(en["rk1.provisional.title"]).toBe("Provisional: fewer than {n} rated results; these ratings may move a lot");
    expect(en["rk1.provisional.intro"]).toMatch(/not ranked/);
    for (const l of ["en", "ms", "zh"] as const) {
      const s = STAFF_DICTIONARIES[l] as Record<string, string>;
      for (const key of ["rts.pol.title", "rts.pol.public", "rts.pol.provisional", "rts.pol.rankAfter", "rts.pol.estimate", "rts.pol.export", "rts.pol.prompt", "rts.act.public", "rts.act.provisional", "rts.act.rankAfter", "rts.act.exported"])
        expect(s[key], `${l} ${key}`).toBeTruthy();
    }
  });

  it("no rating text in English promises certainty: nothing speaks of a true level, skill or accuracy", () => {
    const words = /true level|real level|your skill|accura|exact (level|rating)\b/i;
    for (const dict of [DICTIONARIES.en as Record<string, string>, STAFF_DICTIONARIES.en as Record<string, string>])
      for (const [key, text] of Object.entries(dict))
        if (/^(rt|rts|rk1)\./.test(key) || key.startsWith("err.RT_")) {
          // "do not make it exact" is the opposite of a promise.
          expect(text.replace(/do not make it exact/g, ""), key).not.toMatch(words);
        }
  });
});
