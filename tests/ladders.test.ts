/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { counterEntrant, guardianEntrant, type Entrant } from "../src/lib/competition-entrants";
import { getDb } from "../src/lib/db";
import {
  answer,
  challenge,
  changeSettings,
  confirm,
  createLadder,
  decide,
  dispute,
  endSeason,
  forgetLadderPlayer,
  freeze,
  join,
  joinAs,
  ladderDetail,
  ladderHousekeeping,
  leave,
  moveTo,
  myPlaces,
  ranksOf,
  replay,
  report,
  thaw,
  withdraw,
  type LadderEvent,
  type LadderInput,
} from "../src/lib/ladders";
import { addManaged } from "../src/lib/managed-people";
import { setEventRated } from "../src/lib/ratings";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Club ladders (lib/ladders.ts; ADR 0033): joining by who a ladder is for, the challenge rules, the life of a challenge,
 * the ranks as the replay of the ledger (a correction replaces an event in place), what the scheduler does by itself, freezes,
 * managers' overrides, seasons, minors, and a rated ladder's results in the ratings ledger.
 */

let venueId: number;
let adminId: number;
let n = 0;
const manager = { adminId: null as number | null, name: "Musa Manager" };

async function person(name = "Lad"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Player${n}`, email: `ld${n}@ladder.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  manager.adminId = adminId;
  venueId = (await listVenues())[0].id;
});

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${r.code ?? ""})`);
  return r.value;
}

async function ladder(over: Partial<LadderInput> = {}) {
  n++;
  return ok(await createLadder({ venueId, name: `Club Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, ...over }, adminId));
}

/** A ladder with `count` adult players joined in order, best first; their accounts and place ids. */
async function populated(count = 6, over: Partial<LadderInput> = {}) {
  const l = await ladder(over);
  const players: { user: User; id: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await person();
    const done = ok(await join(user, l.id, { adult: true }));
    players.push({ user, id: done.playerId });
  }
  return { l, players };
}

const season = async (ladderId: number) => (await ladderDetail(ladderId))!.viewing!;
const ids = async (ladderId: number) => (await ranksOf((await season(ladderId)).id)).map((r) => r.playerId);

/** The stored ranks are the replay of the ledger, always. */
async function expectReplayEquality(ladderId: number) {
  const s = await season(ladderId);
  const rows = (await getDb().prepare("SELECT id, ord, kind, player_id, other_id, on_date, data FROM ladder_events WHERE season_id = ? AND voided_at IS NULL ORDER BY ord").all(s.id)) as {
    ord: number;
    kind: LadderEvent["kind"];
    player_id: number;
    other_id: number | null;
    on_date: string;
    data: string;
  }[];
  const fresh = replay(rows.map((r) => ({ ord: r.ord, kind: r.kind, playerId: r.player_id, otherId: r.other_id, on: r.on_date, data: JSON.parse(r.data) })));
  const stored = (await getDb().prepare("SELECT player_id, rank, frozen_until, active_on FROM ladder_ranks WHERE season_id = ? ORDER BY rank").all(s.id)) as {
    player_id: number;
    rank: number;
    frozen_until: string | null;
    active_on: string;
  }[];
  expect(stored.map((r) => [r.player_id, r.rank, r.frozen_until, r.active_on])).toEqual(fresh.map((r) => [r.playerId, r.rank, r.frozenUntil, r.activeOn]));
}

/** Play a challenge to the end: challenger `a` beats (or loses to) `b`, reported by the challenger and confirmed by the other. */
async function play(l: { id: number }, a: { user: User; id: number }, b: { user: User; id: number }, challengerWins = true) {
  const made = ok(await challenge(a.user.id, l.id, a.id, b.id));
  ok(await answer(b.user.id, made.id, { accept: true }));
  const winner = challengerWins ? a.id : b.id;
  const reported = ok(await report(a.user.id, made.id, { winner, score: challengerWins ? "21-10, 21-12" : "10-21, 12-21" }));
  return ok(await confirm(b.user.id, made.id, { version: reported.version }));
}

const mails = async (like: string) => ((await getDb().prepare("SELECT subject, body, recipient FROM messages WHERE subject LIKE ? ORDER BY id").all(`%${like}%`)) as { subject: string; body: string; recipient: string }[]);

describe("setting one up", () => {
  it("is scored by a template as a league is, with settings that have defaults and limits", async () => {
    const l = await ladder();
    expect(l.settings).toMatchObject({ reach: 3, respondDays: 3, playDays: 14, cooldownDays: 14, inactiveDays: 30, inactiveDrop: 1, freezeMaxDays: 60, declineIs: "free" });
    expect(l.audience).toBe("adults");
    expect(l.rules.scoring.kind).toBe("sets");
    expect((await ladderDetail(l.id))!.viewing).toMatchObject({ number: 1, endedOn: null });
    expect(await createLadder({ venueId, name: "x", sport: "badminton", teamSize: 1, level: null }, adminId)).toMatchObject({ ok: false });
    expect(await createLadder({ venueId, name: "Too Far Ladder", sport: "badminton", teamSize: 1, level: null, settings: { reach: 99 } }, adminId)).toMatchObject({ ok: false });
    expect(await createLadder({ venueId, name: "Odd Ladder", sport: "badminton", teamSize: 1, level: null, audience: "elders" as never }, adminId)).toMatchObject({ ok: false, code: "LD_AUDIENCE" });
    const changed = ok(await changeSettings(l.id, { reach: 5 }));
    expect(changed.settings.reach).toBe(5);
  });
});

describe("joining", () => {
  it("puts newcomers at the bottom, once, and an adult ladder asks them to say they are 18 or over", async () => {
    const l = await ladder();
    const a = await person();
    expect(await join(a, l.id)).toMatchObject({ ok: false, code: "LD_ADULT_DECLARE" });
    ok(await join(a, l.id, { adult: true }));
    const b = await person();
    ok(await join(b, l.id, { adult: true }));
    expect((await ladderDetail(l.id))!.rows.map((r) => [r.rank, r.name.split(" ")[0]])).toEqual([[1, "Lad"], [2, "Lad"]]);
    expect(await join(a, l.id, { adult: true })).toMatchObject({ ok: false, code: "LD_ALREADY_IN" });
    expect((await mails("You are on the ladder")).length).toBeGreaterThanOrEqual(2);
    await expectReplayEquality(l.id);
  });

  it("is for adults or for juniors: no child on an adult ladder, no adult's own place on a junior one", async () => {
    const adults = await ladder();
    const juniors = await ladder({ audience: "juniors" });
    const mum = await person("Mum");
    const kid = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error("kid");
    const guardian = (await guardianEntrant(mum, kid.person.id)) as Entrant;
    expect(await joinAs(guardian, adults.id, { adult: true })).toMatchObject({ ok: false, code: "LD_ADULTS_ONLY" });
    expect(await join(mum, juniors.id, { adult: true })).toMatchObject({ ok: false, code: "LD_JUNIORS_ONLY" });
    const placed = ok(await joinAs(guardian, juniors.id));
    expect(placed.playerId).toBeGreaterThan(0);
    // At the counter: staff cannot put a person with no participant on a junior ladder, nor a participant on an adult one.
    const counter = (await counterEntrant(venueId, { id: adminId, name: "Desk" }, { phone: "0123456789", name: "Walk In" })) as Entrant;
    expect(await joinAs(counter, juniors.id)).toMatchObject({ ok: false, code: "LD_JUNIORS_ONLY" });
    ok(await joinAs(counter, adults.id, { adult: true }));
  });

  it("shows a junior ladder's names short and an adult ladder's as given; nothing of a child's contact", async () => {
    const juniors = await ladder({ audience: "juniors" });
    const mum = await person("Mum");
    const kid = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error("kid");
    ok(await joinAs((await guardianEntrant(mum, kid.person.id)) as Entrant, juniors.id));
    const view = (await ladderDetail(juniors.id))!;
    expect(view.rows[0].name).toBe("Aina B.");
    expect(JSON.stringify(view)).not.toContain("Binti Lim");
    expect(JSON.stringify(view)).not.toContain("0138");
  });

  it("keeps a women's ladder to women, as a league does", async () => {
    const l = await ladder({ who: "women" });
    const u = await person();
    const refused = await join(u, l.id, { adult: true });
    expect(refused.ok).toBe(false);
  });
});

describe("challenging", () => {
  it("allows only players within reach above, none frozen or in a challenge already, and tells the challenged", async () => {
    const { l, players } = await populated(6);
    const [p1, p2, , , p5, p6] = players;
    expect(await challenge(p6.user.id, l.id, p6.id, p1.id)).toMatchObject({ ok: false, code: "LD_REACH" });
    expect(await challenge(p1.user.id, l.id, p1.id, p6.id)).toMatchObject({ ok: false, code: "LD_NOT_ABOVE" });
    expect(await challenge(p5.user.id, l.id, p6.id, p5.id)).toMatchObject({ ok: false, code: "LD_NOT_YOURS" });
    const made = ok(await challenge(p6.user.id, l.id, p6.id, p5.id));
    expect(made).toMatchObject({ status: "pending", challengerRank: 6, challengedRank: 5, awaiting: "challenged" });
    expect((await mails("has challenged you")).some((m) => m.body.includes("forfeited"))).toBe(true);
    // One open challenge at a time, for either side.
    expect(await challenge(p6.user.id, l.id, p6.id, players[3].id)).toMatchObject({ ok: false, code: "LD_BUSY_ME" });
    expect(await challenge((await person()).id, l.id, p6.id, players[3].id)).toMatchObject({ ok: false, code: "LD_NOT_YOURS" });
    void p2;
    const four = players[3];
    expect(await challenge(p5.user.id, l.id, p5.id, four.id)).toMatchObject({ ok: false, code: "LD_BUSY_ME" });
    // The ladder says who may be challenged and why not.
    const mine = (await myPlaces(four.user.id, l.id))[0];
    expect(mine.targets.map((t) => [t.rank, t.not?.code ?? null])).toEqual([[1, null], [2, null], [3, null]]);
    const six = (await myPlaces(p6.user.id, l.id))[0];
    expect(six.open).toHaveLength(1);
    expect(six.targets.find((t) => t.rank === 5)!.not?.code).toBe("LD_BUSY_ME");
    await expectReplayEquality(l.id);
  });

  it("holds the same two apart for the cooldown after they play", async () => {
    const { l, players } = await populated(4);
    await play(l, players[3], players[2]);
    expect(await ids(l.id)).toEqual([players[0].id, players[1].id, players[3].id, players[2].id]);
    // 3 (now rank 4) challenges the one who took their place: within the cooldown, refused.
    expect(await challenge(players[2].user.id, l.id, players[2].id, players[3].id)).toMatchObject({ ok: false, code: "LD_COOLDOWN" });
    await getDb().prepare("UPDATE ladder_challenges SET resolved_on = ? WHERE ladder_id = ?").run(addDays(todayISO(), -20), l.id);
    ok(await challenge(players[2].user.id, l.id, players[2].id, players[3].id));
  });
});

describe("the life of a challenge", () => {
  it("is answered, played, reported, confirmed, and moves the ranks by the published rule", async () => {
    const { l, players } = await populated(5);
    const [p1, p2, p3, p4, p5] = players;
    const made = ok(await challenge(p5.user.id, l.id, p5.id, p3.id));
    // Only the challenged answers, and only while it waits for them.
    expect(await answer(p5.user.id, made.id, { accept: true })).toMatchObject({ ok: false, code: "LD_NOT_AWAITING" });
    expect(await report(p5.user.id, made.id, { winner: p5.id, score: "21-10, 21-12" })).toMatchObject({ ok: false, code: "LD_NOT_ACCEPTED" });
    const accepted = ok(await answer(p3.user.id, made.id, { accept: true }, { version: made.version }));
    expect(accepted.status).toBe("accepted");
    expect(accepted.playBy).toBe(addDays(todayISO(), 14));
    expect(await answer(p3.user.id, made.id, { accept: true }, { version: made.version })).toMatchObject({ ok: false, code: "LD_CHANGED" });
    // Contact for arranging it: the other side's number, on an adult ladder, once accepted.
    const mine = (await myPlaces(p5.user.id, l.id))[0];
    expect(mine.open[0].contact?.phone).toMatch(/^0138/);
    // The challenged reports in their own games first; it is kept with the challenger's first.
    expect(await report(p3.user.id, made.id, { winner: p5.id, score: "21-10, 12-21" })).toMatchObject({ ok: false });
    expect(await report(p3.user.id, made.id, { winner: 999999, score: "21-10, 21-12" })).toMatchObject({ ok: false, code: "LD_WINNER" });
    const reported = ok(await report(p3.user.id, made.id, { winner: p5.id, score: "10-21, 12-21" }));
    expect(reported).toMatchObject({ status: "reported", score: "21-10, 21-12", reportedBy: p3.id });
    // The reporter cannot confirm their own report; the other side can.
    expect(await confirm(p3.user.id, made.id, { version: reported.version })).toMatchObject({ ok: false, code: "LD_NOTHING_TO_CONFIRM" });
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p3.id, p4.id, p5.id]);
    const done = ok(await confirm(p5.user.id, made.id, { version: reported.version }));
    expect(done.status).toBe("confirmed");
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p5.id, p3.id, p4.id]);
    await expectReplayEquality(l.id);
    // Both sides are told where they stand.
    expect((await mails(`A ladder result: ${l.name}`)).length).toBe(2);
    expect(await report(p5.user.id, made.id, { winner: p5.id, score: "21-10, 21-12" })).toMatchObject({ ok: false, code: "LD_RESULT_SETTLED" });
  });

  it("leaves the ranks when the challenged wins, and checks the score by the ladder's rules", async () => {
    const { l, players } = await populated(4);
    const [p1, p2, p3, p4] = players;
    const made = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    ok(await answer(p3.user.id, made.id, { accept: true }));
    expect(await report(p4.user.id, made.id, { winner: p4.id, score: "banana" })).toMatchObject({ ok: false });
    expect(await report(p4.user.id, made.id, { winner: p3.id, score: "10-21, 12-21" })).toMatchObject({ ok: true });
    ok(await confirm(p3.user.id, made.id));
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p3.id, p4.id]);
  });

  it("goes to the venue when disputed, who decides it, and a result nobody answers in three days stands", async () => {
    const { l, players } = await populated(4);
    const [, , p3, p4] = players;
    const made = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    ok(await answer(p3.user.id, made.id, { accept: true }));
    const reported = ok(await report(p4.user.id, made.id, { winner: p4.id, score: "21-10, 21-12" }));
    expect(await dispute(p3.user.id, made.id, "no", { version: reported.version })).toMatchObject({ ok: false, code: "LD_REASON" });
    const disputed = ok(await dispute(p3.user.id, made.id, "It went to a third game", { version: reported.version }));
    expect(disputed.status).toBe("disputed");
    expect(await report(p4.user.id, made.id, { winner: p4.id, score: "21-10, 21-12" })).toMatchObject({ ok: false, code: "LD_DISPUTED" });
    expect(await decide(made.id, manager, { winner: p3.id, score: "21-18, 15-21, 21-17" }, "")).toMatchObject({ ok: false, code: "LD_REASON" });
    const decided = ok(await decide(made.id, manager, { winner: p3.id, score: "10-21, 21-18, 17-21" }, "Both agreed it went to three games"));
    expect(decided).toMatchObject({ status: "confirmed", winner: p3.id });
    expect(await ids(l.id)).toEqual(await ids(l.id));
    await expectReplayEquality(l.id);
    // Unanswered: stands after three days.
    const second = await populated(3);
    const [, s2, s3] = second.players;
    const c = ok(await challenge(s3.user.id, second.l.id, s3.id, s2.id));
    ok(await answer(s2.user.id, c.id, { accept: true }));
    ok(await report(s3.user.id, c.id, { winner: s3.id, score: "21-10, 21-12" }));
    expect((await ladderHousekeeping()).confirmed).toBe(0);
    await getDb().prepare("UPDATE ladder_challenges SET reported_at = datetime('now', '-4 days') WHERE id = ?").run(c.id);
    expect((await ladderHousekeeping()).confirmed).toBe(1);
    expect((await ladderDetail(second.l.id))!.challenges[0].status).toBe("confirmed");
    expect(await ids(second.l.id)).toEqual([second.players[0].id, s3.id, s2.id]);
    expect((await ladderHousekeeping()).confirmed).toBe(0);
    await expectReplayEquality(second.l.id);
  });

  it("is declined freely or as a forfeit, as the ladder says; and proposing a time hands the answer on", async () => {
    const free = await populated(3);
    const [, f2, f3] = free.players;
    const c1 = ok(await challenge(f3.user.id, free.l.id, f3.id, f2.id));
    expect(await answer(f3.user.id, c1.id, { decline: true })).toMatchObject({ ok: false, code: "LD_NOT_AWAITING" });
    expect(ok(await answer(f2.user.id, c1.id, { decline: true })).status).toBe("declined");
    expect(await ids(free.l.id)).toEqual(free.players.map((p) => p.id));
    const hard = await populated(3, { settings: { declineIs: "forfeit" } });
    const [h1, h2, h3] = hard.players;
    void h1;
    const c2 = ok(await challenge(h3.user.id, hard.l.id, h3.id, h2.id));
    const lost = ok(await answer(h2.user.id, c2.id, { decline: true }));
    expect(lost).toMatchObject({ status: "walkover", forfeit: true, winner: h3.id });
    expect(await ids(hard.l.id)).toEqual([h1.id, h3.id, h2.id]);
    // A proposed time: the challenged suggests a day, the challenger accepts it.
    const dance = await populated(3);
    const [, d2, d3] = dance.players;
    const c3 = ok(await challenge(d3.user.id, dance.l.id, d3.id, d2.id));
    const day = addDays(todayISO(), 5);
    const proposed = ok(await answer(d2.user.id, c3.id, { propose: true, onDate: day, minute: 19 * 60 }));
    expect(proposed).toMatchObject({ status: "pending", awaiting: "challenger", proposedBy: d2.id });
    expect(await answer(d2.user.id, c3.id, { accept: true })).toMatchObject({ ok: false, code: "LD_NOT_AWAITING" });
    const agreed = ok(await answer(d3.user.id, c3.id, { accept: true }));
    expect(agreed).toMatchObject({ status: "accepted", agreedOn: day, agreedMin: 19 * 60 });
    // The challenger can withdraw a challenge not yet played; nobody moves.
    const c4 = ok(await withdraw(d3.user.id, c3.id));
    expect(c4.status).toBe("cancelled");
    expect(await ids(dance.l.id)).toEqual(dance.players.map((p) => p.id));
    await expectReplayEquality(dance.l.id);
  });
});

describe("what the scheduler does by itself", () => {
  it("forfeits a challenge the challenged ignored, once, taking their place; lapses what is not played in time", async () => {
    const { l, players } = await populated(4);
    const [p1, p2, p3, p4] = players;
    const ignored = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    expect(await ladderHousekeeping()).toMatchObject({ forfeited: 0 });
    await getDb().prepare("UPDATE ladder_challenges SET respond_by = ? WHERE id = ?").run(addDays(todayISO(), -1), ignored.id);
    const first = await ladderHousekeeping();
    expect(first.forfeited).toBe(1);
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p4.id, p3.id]);
    // Running it again, or on two servers at once, moves nothing more.
    const again = await Promise.all([ladderHousekeeping(), ladderHousekeeping()]);
    expect(again.every((x) => x.forfeited === 0 && x.dropped === 0)).toBe(true);
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p4.id, p3.id]);
    expect((await mails("A challenge ended")).some((m) => m.body.includes("forfeited"))).toBe(true);
    // Accepted and never played.
    const slow = ok(await challenge(p3.user.id, l.id, p3.id, p2.id));
    ok(await answer(p2.user.id, slow.id, { accept: true }));
    await getDb().prepare("UPDATE ladder_challenges SET play_by = ? WHERE id = ?").run(addDays(todayISO(), -1), slow.id);
    expect((await ladderHousekeeping()).lapsed).toBe(1);
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p4.id, p3.id]);
    // A counter-proposal the challenger leaves unanswered lapses with no penalty to anybody.
    const stuck = ok(await challenge(p4.user.id, l.id, p4.id, p2.id));
    ok(await answer(p2.user.id, stuck.id, { propose: true, onDate: addDays(todayISO(), 3) }));
    await getDb().prepare("UPDATE ladder_challenges SET respond_by = ? WHERE id = ?").run(addDays(todayISO(), -1), stuck.id);
    expect((await ladderHousekeeping()).lapsed).toBe(1);
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p4.id, p3.id]);
    await expectReplayEquality(l.id);
  });

  it("drops a player idle too long by the ladder's places, once per period, and not while frozen or in a challenge", async () => {
    const { l, players } = await populated(5, { settings: { inactiveDays: 30, inactiveDrop: 2 } });
    const [p1, p2, p3, p4, p5] = players;
    // Everybody has been on the ladder 40 days, except p2 (active yesterday).
    await getDb().prepare("UPDATE ladder_events SET on_date = ? WHERE ladder_id = ?").run(addDays(todayISO(), -40), l.id);
    await getDb().prepare("UPDATE ladder_events SET on_date = ? WHERE ladder_id = ? AND player_id = ?").run(addDays(todayISO(), -1), l.id, p2.id);
    await getDb().prepare("DELETE FROM ladder_ranks WHERE season_id = ?").run((await season(l.id)).id);
    ok(await freeze(p5.user.id, p5.id, addDays(todayISO(), 30)));
    const run = await ladderHousekeeping();
    // p1, p3 and p4 dropped; p2 (active) and p5 (frozen) not.
    expect(run.dropped).toBe(3);
    const now = await ids(l.id);
    expect(now).toHaveLength(5);
    expect(now.indexOf(p1.id)).toBeGreaterThan(0);
    // Idle again straight after: nothing, since the drop counts as activity.
    expect((await ladderHousekeeping()).dropped).toBe(0);
    expect((await mails(`You moved down the ladder: ${l.name}`)).length).toBe(3);
    expect(p3.id && p4.id).toBeTruthy();
    await expectReplayEquality(l.id);
    // Nothing is dropped on a ladder that turns it off.
    const off = await populated(3, { settings: { inactiveDays: 0 } });
    await getDb().prepare("UPDATE ladder_events SET on_date = ? WHERE ladder_id = ?").run(addDays(todayISO(), -400), off.l.id);
    expect((await ladderHousekeeping()).dropped).toBe(0);
  });
});

describe("freezes", () => {
  it("keep a place out of play until a day: not challenged, not challenging, open challenges cancelled, thawed by the scheduler or sooner", async () => {
    const { l, players } = await populated(4);
    const [p1, p2, p3, p4] = players;
    const open = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    expect(await freeze(p3.user.id, p3.id, addDays(todayISO(), 90))).toMatchObject({ ok: false, code: "LD_FREEZE_LONG" });
    expect(await freeze(p3.user.id, p3.id, todayISO())).toMatchObject({ ok: false, code: "LD_FREEZE_DATE" });
    expect(await freeze(p4.user.id, p3.id, addDays(todayISO(), 10))).toMatchObject({ ok: false, code: "LD_NOT_YOURS" });
    ok(await freeze(p3.user.id, p3.id, addDays(todayISO(), 10)));
    expect((await ladderDetail(l.id))!.challenges.find((c) => c.id === open.id)!.status).toBe("cancelled");
    expect((await mails("A challenge ended")).some((m) => m.body.includes("frozen"))).toBe(true);
    expect(await challenge(p4.user.id, l.id, p4.id, p3.id)).toMatchObject({ ok: false, code: "LD_FROZEN_THEM" });
    expect(await challenge(p3.user.id, l.id, p3.id, p2.id)).toMatchObject({ ok: false, code: "LD_FROZEN_ME" });
    // The rank is held.
    expect(await ids(l.id)).toEqual([p1.id, p2.id, p3.id, p4.id]);
    // The scheduler thaws it after its last day.
    await getDb().prepare("UPDATE ladder_ranks SET frozen_until = ? WHERE player_id = ?").run(addDays(todayISO(), -1), p3.id);
    await getDb().prepare("UPDATE ladder_events SET data = ? WHERE kind = 'freeze' AND player_id = ?").run(JSON.stringify({ until: addDays(todayISO(), -1) }), p3.id);
    expect((await ladderHousekeeping()).thawed).toBe(1);
    expect((await ranksOf((await season(l.id)).id)).find((r) => r.playerId === p3.id)!.frozenUntil).toBeNull();
    // A thaw sooner is the player's own.
    ok(await freeze(p2.user.id, p2.id, addDays(todayISO(), 5)));
    ok(await thaw(p2.user.id, p2.id));
    expect(await thaw(p2.user.id, p2.id)).toMatchObject({ ok: false, code: "LD_NOT_FROZEN" });
    await expectReplayEquality(l.id);
  });
});

describe("the ledger, corrections and a manager's overrides", () => {
  it("re-derives every rank after a corrected result from the ordered ledger: never drift", async () => {
    const { l, players } = await populated(6);
    const [p1, p2, p3, p4, p5, p6] = players;
    const first = await play(l, p5, p4);
    await play(l, p6, p4);
    await play(l, p3, p2);
    const asPlayed = await ids(l.id);
    expect(asPlayed).toEqual([p1.id, p3.id, p2.id, p5.id, p6.id, p4.id]);
    // The first result was the other way round: the venue corrects it, with a reason, and everything after is replayed.
    const corrected = ok(await decide(first.id, manager, { winner: p4.id, score: "10-21, 12-21" }, "The score was entered the wrong way round"));
    expect(corrected.winner).toBe(p4.id);
    await expectReplayEquality(l.id);
    // The corrected ledger as a fresh replay: 5 v 4 won by 4 means nobody moved; 6 v 4 (6 below 4 after) then moves as it did.
    const fresh = await ids(l.id);
    expect(fresh).not.toEqual(asPlayed);
    expect(fresh.slice(0, 3)).toEqual([p1.id, p3.id, p2.id]);
    // The ledger keeps both: the voided event and its replacement, in the same place.
    const events = (await ladderDetail(l.id, { forStaff: true }))!.events!.filter((e) => e.kind === "result");
    const replaced = events.find((e) => e.voided && e.voidedReason === "The score was entered the wrong way round")!;
    const replacement = events.find((e) => e.replaces === replaced.id)!;
    expect(replacement.ord).toBe(replaced.ord);
    // Voiding it removes its effect; clearing puts the match back to be played; both replay.
    ok(await decide(first.id, manager, { void: true }, "Not a ladder match"));
    await expectReplayEquality(l.id);
    expect((await ladderDetail(l.id))!.challenges.find((c) => c.id === first.id)!.status).toBe("void");
    expect(await decide(first.id, manager, { clear: true }, "")).toMatchObject({ ok: false, code: "LD_REASON" });
    expect((await mails("The venue decided")).length).toBeGreaterThan(0);
  });

  it("lets a manager move or remove somebody, with a reason, and tells them", async () => {
    const { l, players } = await populated(5);
    expect(await moveTo(players[4].id, 1, { name: "Musa" }, "")).toMatchObject({ ok: false, code: "LD_REASON" });
    expect(await moveTo(players[4].id, 0, { name: "Musa" }, "Returning champion")).toMatchObject({ ok: false, code: "LD_RANK" });
    expect(ok(await moveTo(players[4].id, 1, { name: "Musa" }, "Returning champion")).rank).toBe(1);
    expect(await ids(l.id)).toEqual([players[4].id, ...players.slice(0, 4).map((p) => p.id)]);
    expect((await mails(`Your ladder rank was changed: ${l.name}`)).length).toBe(1);
    ok(await leave(players[0].id, { name: "Musa", reason: "Moved away" }));
    expect(await ids(l.id)).toEqual([players[4].id, ...players.slice(1, 4).map((p) => p.id)]);
    expect(await leave(players[1].id, { name: "Musa" })).toMatchObject({ ok: false, code: "LD_REASON" });
    // A leaver's open challenge is cancelled with no effect.
    const c = ok(await challenge(players[3].user.id, l.id, players[3].id, players[2].id));
    ok(await leave(players[3].id));
    expect((await ladderDetail(l.id))!.challenges.find((x) => x.id === c.id)!.status).toBe("cancelled");
    await expectReplayEquality(l.id);
  });

  it("is erased by name for a person who is forgotten, without moving anybody else beyond the gap", async () => {
    const { l, players } = await populated(4);
    await forgetLadderPlayer(players[1].user.id, "(removed)");
    expect(await ids(l.id)).toEqual([players[0].id, players[2].id, players[3].id]);
    const name = (await getDb().prepare("SELECT name, user_id FROM ladder_players WHERE id = ?").get(players[1].id)) as { name: string; user_id: number | null };
    expect(name).toEqual({ name: "(removed)", user_id: null });
    await expectReplayEquality(l.id);
  });
});

describe("minors: a guardian acts, a stranger does not", () => {
  it("has the guardian challenge, answer and report for the child, never another adult, and shows no contact", async () => {
    const l = await ladder({ audience: "juniors" });
    const mum = await person("Mum");
    const dad = await person("Dad");
    const stranger = await person("Stranger");
    const kidA = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    const kidB = await addManaged(dad.id, { displayName: "Ben Tan", relationship: "parent", authority: true }, dad.name);
    if (!kidA.ok || !kidB.ok) throw new Error("kids");
    const a = ok(await joinAs((await guardianEntrant(mum, kidA.person.id)) as Entrant, l.id));
    const b = ok(await joinAs((await guardianEntrant(dad, kidB.person.id)) as Entrant, l.id));
    expect(await challenge(stranger.id, l.id, a.playerId, b.playerId)).toMatchObject({ ok: false, code: "LD_NOT_YOURS" });
    // The younger on rank 2 (Ben) is challenged by Aina's guardian? Aina is rank 1: Ben challenges up.
    const made = ok(await challenge(dad.id, l.id, b.playerId, a.playerId));
    expect(made).toMatchObject({ challengerName: "Ben T.", challengedName: "Aina B." });
    expect(await answer(stranger.id, made.id, { accept: true })).toMatchObject({ ok: false });
    ok(await answer(mum.id, made.id, { accept: true }));
    const place = (await myPlaces(dad.id, l.id))[0];
    expect(place.participantId).toBe(kidB.person.id);
    expect(place.open[0].contact).toBeNull();
    // Told to the guardian, saying whose it is.
    const told = (await getDb().prepare("SELECT body FROM messages WHERE recipient = ? ORDER BY id").all(mum.email)) as { body: string }[];
    expect(told.some((m) => m.body.includes("Aina Binti Lim"))).toBe(true);
    ok(await report(dad.id, made.id, { winner: b.playerId, score: "21-10, 21-12" }));
    ok(await confirm(mum.id, made.id));
    expect((await ladderDetail(l.id))!.rows.map((r) => r.name)).toEqual(["Ben T.", "Aina B."]);
    // A guardian whose two children play each other answers for neither.
    const sibling = await addManaged(mum.id, { displayName: "Chloe Binti Lim", relationship: "parent", authority: true }, mum.name);
    if (!sibling.ok) throw new Error("sibling");
    const c = ok(await joinAs((await guardianEntrant(mum, sibling.person.id)) as Entrant, l.id));
    const cross = ok(await challenge(mum.id, l.id, c.playerId, a.playerId));
    expect(await answer(mum.id, cross.id, { accept: true })).toMatchObject({ ok: false });
  });
});

describe("seasons and the archive", () => {
  it("ends a season: open challenges cancelled, the final order archived, the next season carried over in it", async () => {
    const { l, players } = await populated(4);
    await play(l, players[3], players[2]);
    const open = ok(await challenge(players[2].user.id, l.id, players[2].id, players[1].id));
    const after = ok(await endSeason(l.id));
    expect(after.season!.number).toBe(2);
    const detail = (await ladderDetail(l.id))!;
    expect(detail.seasons.map((s) => [s.number, s.endedOn !== null])).toEqual([[2, false], [1, true]]);
    const last = (await ladderDetail(l.id, { season: 1 }))!;
    expect(last.viewing!.finalRanks!.map((f) => f.playerId)).toEqual([players[0].id, players[1].id, players[3].id, players[2].id]);
    expect(last.rows.map((r) => r.playerId)).toEqual(last.viewing!.finalRanks!.map((f) => f.playerId));
    expect(last.challenges.find((c) => c.id === open.id)!.status).toBe("cancelled");
    // The new season starts from that order, with a clean ledger, and nobody is idle.
    expect(await ids(l.id)).toEqual([players[0].id, players[1].id, players[3].id, players[2].id]);
    await expectReplayEquality(l.id);
    // Closing ends it for good.
    const closed = ok(await endSeason(l.id, { close: true }));
    expect(closed.status).toBe("closed");
    expect(await join(await person(), l.id, { adult: true })).toMatchObject({ ok: false, code: "LD_CLOSED" });
  });
});

describe("ratings", () => {
  it("reads a rated ladder's confirmed results as played matches and forfeits as walkovers, and replays a correction", async () => {
    const { l, players } = await populated(4);
    expect((await setEventRated("ladder", l.id, true)).ok).toBe(true);
    const live = async () => ((await getDb().prepare("SELECT source_match, outcome, kind FROM rated_results WHERE source_kind = 'ladder' AND source_id = ? AND voided_at IS NULL ORDER BY source_match").all(l.id)) as { source_match: number; outcome: string; kind: string }[]);
    expect(await live()).toHaveLength(0);
    const first = await play(l, players[3], players[2]);
    let rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_match: first.id, kind: "played" });
    // A forfeit is a walkover: written, and it moves nothing in the rating.
    const ignored = ok(await challenge(players[2].user.id, l.id, players[2].id, players[1].id));
    await getDb().prepare("UPDATE ladder_challenges SET respond_by = ? WHERE id = ?").run(addDays(todayISO(), -1), ignored.id);
    await ladderHousekeeping();
    const { syncRatedEvent } = await import("../src/lib/ratings");
    await syncRatedEvent("ladder", l.id);
    rows = await live();
    expect(rows.map((r) => r.kind)).toEqual(["played", "walkover"]);
    // A correction voids the old row and writes the new one.
    ok(await decide(first.id, manager, { winner: players[2].id, score: "10-21, 12-21" }, "Wrong way round"));
    rows = await live();
    expect(rows.find((r) => r.source_match === first.id)!.outcome).not.toBe("1");
    const all = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = 'ladder' AND source_id = ? AND source_match = ?").get(l.id, first.id)) as { n: number };
    expect(all.n).toBe(2);
    // A void removes it from the ratings.
    ok(await decide(first.id, manager, { void: true }, "Not a ladder match"));
    expect((await live()).map((r) => r.source_match)).not.toContain(first.id);
    // Once a result is in, the ladder can no longer be marked unrated.
    expect(await setEventRated("ladder", l.id, false)).toMatchObject({ ok: false, code: "RT_STARTED" });
  });

  it("is not rated unless the venue marks it", async () => {
    const { l, players } = await populated(3);
    await play(l, players[2], players[1]);
    const rows = (await getDb().prepare("SELECT 1 FROM rated_results WHERE source_kind = 'ladder' AND source_id = ?").all(l.id)) as unknown[];
    expect(rows).toHaveLength(0);
  });
});

describe("two results at once", () => {
  it("leave the ranks as the replay of the ledger, whichever finished first", async () => {
    const { l, players } = await populated(6);
    const [, , p3, p4, p5, p6] = players;
    const x = ok(await challenge(p4.user.id, l.id, p4.id, p3.id));
    const y = ok(await challenge(p6.user.id, l.id, p6.id, p5.id));
    ok(await answer(p3.user.id, x.id, { accept: true }));
    ok(await answer(p5.user.id, y.id, { accept: true }));
    const rx = ok(await report(p4.user.id, x.id, { winner: p4.id, score: "21-10, 21-12" }));
    const ry = ok(await report(p6.user.id, y.id, { winner: p6.id, score: "21-10, 21-12" }));
    const both = await Promise.all([confirm(p3.user.id, x.id, { version: rx.version }), confirm(p5.user.id, y.id, { version: ry.version })]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(new Set(await ids(l.id)).size).toBe(6);
    await expectReplayEquality(l.id);
    const order = await ids(l.id);
    // 4 over 3 and 6 over 5 are independent pairs: both moves are made, in either order.
    expect(order.indexOf(p4.id)).toBeLessThan(order.indexOf(p3.id));
    expect(order.indexOf(p6.id)).toBeLessThan(order.indexOf(p5.id));
    // The same answer sent twice at once confirms once.
    const z = ok(await challenge(p5.user.id, l.id, p5.id, p4.id));
    ok(await answer(p4.user.id, z.id, { accept: true }));
    const rz = ok(await report(p5.user.id, z.id, { winner: p5.id, score: "21-10, 21-12" }));
    const twice = await Promise.all([confirm(p4.user.id, z.id, { version: rz.version }), confirm(p4.user.id, z.id, { version: rz.version })]);
    expect(twice.filter((r) => r.ok)).toHaveLength(1);
    await expectReplayEquality(l.id);
  });
});
