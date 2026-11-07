import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { GET as adminGet, POST as adminPost } from "../src/app/api/admin/no-show-marks/route";
import { GET as myGet, POST as myPost } from "../src/app/api/my/no-show-marks/route";
import { GET as myGames } from "../src/app/api/my/games/route";
import { GET as attention } from "../src/app/api/admin/attention/route";
import { POST as hostAct } from "../src/app/api/games/[id]/players/[playerId]/route";
import { getDb } from "../src/lib/db";
import { askToJoin, decide, gameById, gamePlayers, MAX_NO_SHOWS, openGame, recentNoShows } from "../src/lib/games";
import { recommendGames, recommendPlayers } from "../src/lib/matchmaking";
import {
  answerNoShow,
  flaggedHosts,
  HOST_MARKS_PER_WEEK,
  HOST_REVERSED_FLAG,
  listNoShowMarks,
  markNoShow,
  MAX_OPEN_ANSWERS,
  myNoShowMarks,
  noShowAttention,
  reviewNoShow,
  withdrawNoShow,
  DISPUTE_LOSS_CAP,
} from "../src/lib/no-show-marks";
import { saveProfile } from "../src/lib/player-profiles";
import { setPlayerLevel } from "../src/lib/games";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A host's no-show mark is reviewable and correctable (ADR 0072, DEC-50): a reason, a notice to the player, a way to answer, a review by
 * the venue's manager, a mark that counts only at its own venue unless the platform owner decides otherwise, limits against abuse, and
 * races that cannot leave a mark half-decided. Run on PGlite and, for the races, on Postgres (TEST_DATABASE_URL).
 */

let n = 0;
let venueA: number;
let venueB: number;
let courtA: number;
let courtB: number;
let slot = 0;
let managerA: Admin;
let managerB: Admin;
let desk: Admin;
let owner: Admin;

async function player(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Tan ${n}`, email: `ns${n}@marks.my`, phone: `01240${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function hostGame(court = courtA) {
  const host = await player("Host");
  slot++;
  const made = await createBooking({ courtId: court, date: addDays(todayISO(), 2 + (slot % 10)), hours: [8 + Math.floor(slot / 10)], name: host.name, phone: host.phone, userId: host.id });
  if (!made.ok) throw new Error("booking");
  const game = await openGame(host.id, { bookingCode: made.booking.code, spots: 3, level: null, share: 0, autoAccept: true });
  if (!game.ok) throw new Error(game.error);
  return { host, booking: made.booking, game: game.game };
}

/** `who` joins a new game that has since been played, `daysAgo` days ago; returns the row to mark. */
async function played(who: User, opts: { court?: number; daysAgo?: number } = {}) {
  const { host, game, booking } = await hostGame(opts.court);
  expect((await askToJoin(who, game.id)).ok).toBe(true);
  await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -(opts.daysAgo ?? 1)), booking.id);
  const row = (await gamePlayers(game.id)).find((p) => p.userId === who.id)!;
  return { host, game, playerId: row.id };
}

const mailsTo = async (u: User, kind = "no_show_notice") =>
  (await getDb().prepare("SELECT subject, body, locale FROM messages WHERE kind = ? AND recipient = ? ORDER BY id").all(kind, u.email)) as { subject: string; body: string; locale: string }[];

const rowOf = async (playerId: number) =>
  (await getDb().prepare("SELECT no_show, no_show_status, no_show_scope, no_show_venue_id, no_show_reason, no_show_reviewed_by FROM open_game_players WHERE id = ?").get(playerId)) as {
    no_show: number; no_show_status: string | null; no_show_scope: string | null; no_show_venue_id: number | null; no_show_reason: string | null; no_show_reviewed_by: number | null;
  };

async function staff(role: "manager" | "desk", venueId: number | null, tag: string): Promise<Admin> {
  const made = await createAdmin({ name: `${tag} Staff`, email: `${tag}@marks.my`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return made.admin;
}

beforeAll(async () => {
  const venues = await listVenues();
  venueA = venues[0].id;
  venueB = venues[1].id;
  courtA = venues[0].courts[0].id;
  courtB = venues[1].courts[0].id;
  managerA = await staff("manager", venueA, "managera");
  managerB = await staff("manager", venueB, "managerb");
  desk = await staff("desk", venueA, "desk");
  owner = await staff("manager", null, "owner");
});

describe("making a mark", () => {
  it("needs a reason, records the venue, and tells the player, once, in their language", async () => {
    const flake = await player("Flake");
    const { host, playerId } = await played(flake);
    expect(await markNoShow(host.id, playerId, "  ")).toMatchObject({ ok: false, code: "NS_REASON" });
    expect(await decide(host.id, playerId, "no_show")).toMatchObject({ ok: false, code: "NS_REASON" });
    expect((await rowOf(playerId)).no_show).toBe(0);

    await getDb().prepare("UPDATE users SET locale = 'ms' WHERE id = ?").run(flake.id);
    expect((await decide(host.id, playerId, "no_show", { reason: "Did not turn up, no message." })).ok).toBe(true);
    expect(await rowOf(playerId)).toMatchObject({ no_show: 1, no_show_status: "in_force", no_show_scope: "venue", no_show_venue_id: venueA, no_show_reason: "Did not turn up, no message." });
    // Doing it again (a double click) changes nothing and tells nobody twice.
    expect((await decide(host.id, playerId, "no_show", { reason: "Did not turn up, no message." })).ok).toBe(true);
    const told = await mailsTo(flake);
    expect(told).toHaveLength(1);
    expect(told[0].locale).toBe("ms");
    expect(told[0].body).toContain("Did not turn up, no message.");
    expect(told[0].body).not.toMatch(/ppl\./);
    // The player sees it, with where it counts, and may answer it.
    expect(await myNoShowMarks(flake.id)).toMatchObject([{ playerId, status: "in_force", scope: "venue", venueName: expect.any(String), reason: "Did not turn up, no message.", canAnswer: true, counts: true }]);
  });

  it("is told in Chinese and Tamil too, and not at all to an account that said it is under 18", async () => {
    const zh = await player("Zhang");
    const ta = await player("Tamil");
    const teen = await player("Teen");
    await saveProfile(teen.id, { adult: false });
    await getDb().prepare("UPDATE users SET locale = 'zh' WHERE id = ?").run(zh.id);
    await getDb().prepare("UPDATE users SET locale = 'ta' WHERE id = ?").run(ta.id);
    for (const who of [zh, ta, teen]) {
      const { host, playerId } = await played(who);
      expect((await markNoShow(host.id, playerId, "Not there at the start")).ok).toBe(true);
    }
    expect((await mailsTo(zh))[0].body).toMatch(/[一-鿿]/);
    expect((await mailsTo(ta))[0].body).toMatch(/[஀-௿]/);
    expect(await mailsTo(teen)).toHaveLength(0);
    // The teenager's marks are still theirs to read and answer on their own page.
    expect((await myNoShowMarks(teen.id))[0]).toMatchObject({ status: "in_force", canAnswer: true });
  });

  it("is refused for somebody who was not in the game, for another host's game, and more than a week after it", async () => {
    const flake = await player("Flake");
    const { host, playerId } = await played(flake);
    const stranger = await player("Host");
    expect(await markNoShow(stranger.id, playerId, "Not there")).toMatchObject({ ok: false, status: 404 });
    await getDb().prepare("UPDATE open_game_players SET status = 'left' WHERE id = ?").run(playerId);
    expect(await markNoShow(host.id, playerId, "Not there")).toMatchObject({ ok: false, code: "NS_NOT_IN" });
    const late = await played(await player("Late"), { daysAgo: 10 });
    expect(await markNoShow(late.host.id, late.playerId, "Not there")).toMatchObject({ ok: false, code: "NS_TOO_LATE" });
    expect((await rowOf(late.playerId)).no_show).toBe(0);
  });

  it("is limited for one host in a week, and the week moves on", async () => {
    const { host, game, booking } = await hostGame();
    for (let i = 0; i < HOST_MARKS_PER_WEEK; i++) {
      const u = await player("Many");
      await getDb()
        .prepare("INSERT INTO open_game_players (game_id, user_id, status, no_show, no_show_status, no_show_scope, no_show_venue_id, no_show_reason, no_show_at) VALUES (?, ?, 'left', 1, 'in_force', 'venue', ?, 'x', datetime('now'))")
        .run(game.id, u.id, venueA);
    }
    const flake = await player("Flake");
    expect((await askToJoin(flake, game.id)).ok).toBe(true);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), booking.id);
    const row = (await gamePlayers(game.id)).find((p) => p.userId === flake.id)!;
    expect(await markNoShow(host.id, row.id, "Not there")).toMatchObject({ ok: false, code: "NS_HOST_LIMIT", status: 429 });
    expect((await rowOf(row.id)).no_show).toBe(0);
    // Another host is not held to this host's count.
    const other = await played(await player("Other"));
    expect((await markNoShow(other.host.id, other.playerId, "Not there")).ok).toBe(true);
    // Marks older than a week stop counting against the host's allowance.
    await getDb().prepare("UPDATE open_game_players SET no_show_at = datetime('now', '-8 days') WHERE game_id = ? AND status = 'left'").run(game.id);
    expect((await markNoShow(host.id, row.id, "Not there")).ok).toBe(true);
  });
});

describe("where a mark counts", () => {
  async function mark(who: User, court: number, reason = "Did not come") {
    const { host, playerId } = await played(who, { court });
    expect((await markNoShow(host.id, playerId, reason)).ok).toBe(true);
    return { host, playerId };
  }

  it("only at the venue of the game: three at one venue stop the player there, not at another", async () => {
    const flake = await player("Flake");
    for (let i = 0; i < MAX_NO_SHOWS; i++) await mark(flake, courtA);
    expect(await recentNoShows(flake.id, venueA)).toBe(MAX_NO_SHOWS);
    expect(await recentNoShows(flake.id, venueB)).toBe(0);
    expect(await recentNoShows(flake.id, null)).toBe(0);
    const here = await hostGame(courtA);
    expect(await askToJoin(flake, here.game.id)).toMatchObject({ ok: false, code: "NO_SHOW_LIMIT" });
    const there = await hostGame(courtB);
    expect((await askToJoin(flake, there.game.id)).ok).toBe(true);
  });

  it("is also what suggestions use: games at the venue are left out, the rest are not, and nobody is stopped everywhere", async () => {
    const me = await player("Suggest");
    await saveProfile(me.id, { adult: true });
    const sport = (await gameById((await hostGame(courtA)).game.id))!.sport;
    await setPlayerLevel(me.id, sport, "intermediate");
    for (let i = 0; i < MAX_NO_SHOWS; i++) await mark(me, courtA);
    const gA = await hostGame(courtA);
    const gB = await hostGame(courtB);
    const found = await recommendGames(me.id, { limit: 50 });
    expect(found.stopped).toBeUndefined();
    expect(found.games.some((g) => g.id === gA.game.id)).toBe(false);
    expect(found.games.some((g) => g.id === gB.game.id)).toBe(true);
    // A host's suggested players: the same player is left out for a game at venue A but not at venue B.
    await saveProfile(me.id, { adult: true, discoverable: true, invitable: true });
    const names = async (g: { host: User; game: { id: number } }) => {
      const out = await recommendPlayers(g.host.id, g.game.id, { limit: 50 });
      return out.ok ? out.players.map((p) => p.userId) : [];
    };
    expect(await names(gA)).not.toContain(me.id);
    expect(await names(gB)).toContain(me.id);
  });

  it("everywhere only when the platform owner decides so, with a written reason", async () => {
    const flake = await player("Flake");
    const marks: number[] = [];
    for (let i = 0; i < MAX_NO_SHOWS; i++) marks.push((await mark(flake, courtA)).playerId);
    for (const id of marks) {
      // Not a manager's to decide, and not without a justification.
      expect(await reviewNoShow(managerA, id, "platform", "Many complaints")).toMatchObject({ ok: false, code: "NS_OWNER_ONLY", status: 403 });
      expect(await reviewNoShow(owner, id, "platform", "")).toMatchObject({ ok: false, code: "NS_REVIEW_NOTE" });
      expect((await reviewNoShow(owner, id, "platform", "Three no-shows at one venue, and the venue asked us to apply it everywhere.")).ok).toBe(true);
    }
    expect(await rowOf(marks[0])).toMatchObject({ no_show_scope: "platform", no_show_status: "upheld" });
    expect(await recentNoShows(flake.id, null)).toBe(MAX_NO_SHOWS);
    expect(await recentNoShows(flake.id, venueB)).toBe(MAX_NO_SHOWS);
    expect(await askToJoin(flake, (await hostGame(courtB)).game.id)).toMatchObject({ ok: false, code: "NO_SHOW_LIMIT" });
    expect((await mailsTo(flake)).some((m) => /every venue/.test(m.body))).toBe(true);
    // And is on record with who and why.
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'no-show.reviewed' AND detail LIKE ?").all(`Mark ${marks[0]}:%`)) as { detail: string }[];
    expect(log).toHaveLength(1);
    expect(log[0].detail).toContain("platform");
  });

  it("a mark from before scopes (status empty) still counts everywhere, as it did", async () => {
    const flake = await player("Legacy");
    for (let i = 0; i < MAX_NO_SHOWS; i++) {
      const { game } = await hostGame(courtA);
      await getDb().prepare("INSERT INTO open_game_players (game_id, user_id, status, no_show) VALUES (?, ?, 'accepted', 1)").run(game.id, flake.id);
    }
    expect(await recentNoShows(flake.id, venueB)).toBe(MAX_NO_SHOWS);
    expect(await askToJoin(flake, (await hostGame(courtB)).game.id)).toMatchObject({ ok: false, code: "NO_SHOW_LIMIT" });
    // Reviewable by the owner, and by no venue's manager.
    const waiting = await listNoShowMarks(owner, "review");
    expect(waiting.filter((m) => m.scope === "legacy_platform").length).toBeGreaterThanOrEqual(MAX_NO_SHOWS);
    expect((await listNoShowMarks(managerA, "review")).every((m) => m.scope !== "legacy_platform")).toBe(true);
    expect((await noShowAttention(owner))!.legacyPlatform).toBeGreaterThanOrEqual(MAX_NO_SHOWS);
  });
});

describe("answering and review", () => {
  async function marked(who?: User) {
    const flake = who ?? (await player("Flake"));
    const { host, playerId } = await played(flake);
    expect((await markNoShow(host.id, playerId, "Did not come")).ok).toBe(true);
    return { flake, host, playerId };
  }

  it("a player answers once; an answered mark does not count until it is decided, and the manager decides it", async () => {
    const { flake, host, playerId } = await marked();
    expect(await answerNoShow(flake.id, playerId, "")).toMatchObject({ ok: false, code: "NS_ANSWER" });
    const other = await player();
    expect(await answerNoShow(other.id, playerId, "It was not me")).toMatchObject({ ok: false, status: 404 });
    expect((await answerNoShow(flake.id, playerId, "I was there at the start, ask the court staff.")).ok).toBe(true);
    expect(await answerNoShow(flake.id, playerId, "Again")).toMatchObject({ ok: false, code: "NS_ANSWERED" });
    expect((await rowOf(playerId)).no_show_status).toBe("disputed");
    expect(await recentNoShows(flake.id, venueA)).toBe(0);
    // The host sees it, and may take their own mark back.
    expect((await gamePlayers((await getDb().prepare("SELECT game_id FROM open_game_players WHERE id = ?").get(playerId) as { game_id: number }).game_id))[0].noShowStatus).toBe("disputed");

    // It waits for the venue's own manager, not another venue's, not the desk.
    const waiting = await listNoShowMarks(managerA, "review");
    expect(waiting.find((m) => m.id === playerId)).toMatchObject({ status: "disputed", answer: expect.stringContaining("court staff"), may: { reverse: true, uphold: true, platform: false } });
    expect((await listNoShowMarks(managerB, "review")).some((m) => m.id === playerId)).toBe(false);
    expect(await reviewNoShow(managerB, playerId, "reverse", "Not mine")).toMatchObject({ ok: false, status: 404 });
    expect(await reviewNoShow(desk, playerId, "reverse", "Not mine")).toMatchObject({ ok: false, status: 403 });
    expect(await listNoShowMarks(desk, "review")).toEqual([]);
    expect((await noShowAttention(managerA))!.answersWaiting).toBeGreaterThanOrEqual(1);
    expect(await noShowAttention(desk)).toBeNull();

    expect(await reviewNoShow(managerA, playerId, "reverse", "")).toMatchObject({ ok: false, code: "NS_REVIEW_NOTE" });
    expect((await reviewNoShow(managerA, playerId, "reverse", "Court staff confirm they were on court.")).ok).toBe(true);
    expect(await rowOf(playerId)).toMatchObject({ no_show: 0, no_show_status: "reversed", no_show_reviewed_by: managerA.id, no_show_reason: "Did not come" });
    // Off for good: it cannot be made again, answered again, or reversed twice.
    expect(await markNoShow(host.id, playerId, "Did not come")).toMatchObject({ ok: false, code: "NS_TAKEN_BACK" });
    expect(await answerNoShow(flake.id, playerId, "More")).toMatchObject({ ok: false, code: "NS_TAKEN_BACK" });
    expect(await reviewNoShow(managerA, playerId, "uphold", "Changed my mind")).toMatchObject({ ok: false, code: "NS_STATE" });
    expect((await mailsTo(flake)).map((m) => m.subject).join("|")).toMatch(/taken off/);
  });

  it("a mark a manager lets stand counts again, cannot be answered twice, and the host cannot take it back", async () => {
    const { flake, host, playerId } = await marked();
    await answerNoShow(flake.id, playerId, "Not true");
    expect((await reviewNoShow(managerA, playerId, "uphold", "The court log shows nobody came.")).ok).toBe(true);
    expect(await recentNoShows(flake.id, venueA)).toBe(1);
    expect(await answerNoShow(flake.id, playerId, "Again")).toMatchObject({ ok: false, code: "NS_REVIEWED" });
    expect(await withdrawNoShow(host.id, playerId)).toMatchObject({ ok: false, code: "NS_REVIEWED" });
    // A mistaken decision can still be corrected later by the manager.
    expect((await reviewNoShow(managerA, playerId, "reverse", "Found the booking was moved.")).ok).toBe(true);
    expect(await recentNoShows(flake.id, venueA)).toBe(0);
  });

  it("the host can take back their own mark: no review, the player told, and it is not counted against the host", async () => {
    const { flake, host, playerId } = await marked();
    expect(await withdrawNoShow((await player()).id, playerId)).toMatchObject({ ok: false, status: 404 });
    expect((await withdrawNoShow(host.id, playerId)).ok).toBe(true);
    expect(await rowOf(playerId)).toMatchObject({ no_show: 0, no_show_status: "withdrawn" });
    expect(await withdrawNoShow(host.id, playerId)).toMatchObject({ ok: false, code: "NS_NONE" });
    expect(await recentNoShows(flake.id, venueA)).toBe(0);
    expect((await mailsTo(flake)).map((m) => m.subject).join("|")).toMatch(/taken off/);
  });

  it("limits repeated answers: a few at a time, and none after several that stood", async () => {
    const flake = await player("Disputer");
    const ids: number[] = [];
    // Spread over the two venues, so that no three at one stop the player from joining the next game.
    for (let i = 0; i < MAX_OPEN_ANSWERS + 1; i++) {
      const { host, playerId } = await played(flake, { court: i % 2 === 0 ? courtA : courtB });
      expect((await markNoShow(host.id, playerId, "Did not come")).ok).toBe(true);
      ids.push(playerId);
    }
    for (let i = 0; i < MAX_OPEN_ANSWERS; i++) expect((await answerNoShow(flake.id, ids[i], "Not me")).ok).toBe(true);
    expect(await answerNoShow(flake.id, ids[MAX_OPEN_ANSWERS], "Not me")).toMatchObject({ ok: false, code: "NS_OPEN_LIMIT", status: 429 });
    expect((await myNoShowMarks(flake.id)).find((m) => m.playerId === ids[MAX_OPEN_ANSWERS])!.canAnswer).toBe(false);
    // Each is let stand: the player has lost that many answers, so the next mark cannot be answered here.
    for (let i = 0; i < DISPUTE_LOSS_CAP; i++) expect((await reviewNoShow(owner, ids[i], "uphold", "Stands.")).ok).toBe(true);
    expect(await answerNoShow(flake.id, ids[MAX_OPEN_ANSWERS], "Not me either")).toMatchObject({ ok: false, code: "NS_DISPUTE_CAP" });
  });

  it("shows staff the hosts whose marks keep being reversed", async () => {
    const { host, playerId: first } = await marked();
    const flagged = async () => (await flaggedHosts(managerA)).find((h) => h.hostId === host.id);
    // The same host marks more players at their own game.
    const ids = [first];
    const game = (await getDb().prepare("SELECT game_id FROM open_game_players WHERE id = ?").get(first)) as { game_id: number };
    for (let i = 1; i < HOST_REVERSED_FLAG; i++) {
      const u = await player("Other");
      await getDb().prepare("INSERT INTO open_game_players (game_id, user_id, status) VALUES (?, ?, 'accepted')").run(game.game_id, u.id);
      const pid = (await gamePlayers(game.game_id)).find((p) => p.userId === u.id)!.id;
      expect((await markNoShow(host.id, pid, "Did not come")).ok).toBe(true);
      ids.push(pid);
    }
    expect(await flagged()).toBeUndefined();
    for (const id of ids) expect((await reviewNoShow(managerA, id, "reverse", "They were there.")).ok).toBe(true);
    expect(await flagged()).toMatchObject({ reversed: HOST_REVERSED_FLAG, marked: HOST_REVERSED_FLAG });
    expect((await flaggedHosts(managerB)).some((h) => h.hostId === host.id)).toBe(false);
    expect((await flaggedHosts(owner)).some((h) => h.hostId === host.id)).toBe(true);
    expect((await noShowAttention(managerA))!.hosts.some((h) => h.hostId === host.id)).toBe(true);
    expect(await flaggedHosts(desk)).toEqual([]);
  });

  it("names are first names only in what staff read", async () => {
    const flake = await player("Flake");
    const { host, playerId } = await played(flake);
    await markNoShow(host.id, playerId, "Did not come");
    const view = (await listNoShowMarks(managerA, "recent")).find((m) => m.id === playerId)!;
    expect(view.playerName).toBe("Flake");
    expect(view.hostName).toBe("Host");
    expect(JSON.stringify(view)).not.toContain("@marks.my");
    expect(JSON.stringify(view)).not.toContain("0124");
  });
});

describe("races", () => {
  it("two answers at once to one mark: one is taken, one refused, the player's state is whole", async () => {
    const flake = await player("Race");
    const { host, playerId } = await played(flake);
    await markNoShow(host.id, playerId, "Did not come");
    const results = await Promise.all([answerNoShow(flake.id, playerId, "First answer"), answerNoShow(flake.id, playerId, "Second answer")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)[0]).toMatchObject({ code: "NS_ANSWERED" });
    const row = (await getDb().prepare("SELECT no_show_status, no_show_dispute_note FROM open_game_players WHERE id = ?").get(playerId)) as { no_show_status: string; no_show_dispute_note: string };
    expect(row.no_show_status).toBe("disputed");
    expect(["First answer", "Second answer"]).toContain(row.no_show_dispute_note);
  });

  it("a double mark is made once and told once; a mark racing the host's own reversal leaves a consistent row", async () => {
    const flake = await player("Race");
    const { host, playerId } = await played(flake);
    const both = await Promise.all([markNoShow(host.id, playerId, "Did not come"), markNoShow(host.id, playerId, "Did not come")]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(await mailsTo(flake)).toHaveLength(1);
    const raced = await Promise.all([withdrawNoShow(host.id, playerId), markNoShow(host.id, playerId, "Did not come")]);
    expect(raced.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const row = await rowOf(playerId);
    // Whatever the order, the row says what its counting says: a counted mark is in force, a taken-back one is not counted.
    expect(row.no_show_status).toMatch(/^(in_force|withdrawn)$/);
    expect(row.no_show === 1).toBe(row.no_show_status === "in_force");
  });

  it("a reversal racing the player's answer ends reversed either way, with one notice, and the answer never revives it", async () => {
    const flake = await player("Race");
    const { host, playerId } = await played(flake);
    await markNoShow(host.id, playerId, "Did not come");
    const [, review] = await Promise.all([answerNoShow(flake.id, playerId, "I was there"), reviewNoShow(managerA, playerId, "reverse", "Checked: they were there.")]);
    expect(review.ok).toBe(true);
    expect(await rowOf(playerId)).toMatchObject({ no_show: 0, no_show_status: "reversed" });
    expect((await mailsTo(flake)).filter((m) => /taken off/.test(m.subject))).toHaveLength(1);
  });

  it("two reviewers deciding at once: one decision stands", async () => {
    const flake = await player("Race");
    const { host, playerId } = await played(flake);
    await markNoShow(host.id, playerId, "Did not come");
    await answerNoShow(flake.id, playerId, "I was there");
    const other = await staff("manager", venueA, `second${n}`);
    const [a, b] = await Promise.all([reviewNoShow(managerA, playerId, "reverse", "They were there."), reviewNoShow(other, playerId, "uphold", "Log says no.")]);
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const row = await rowOf(playerId);
    // The state matches the last decision made, and the player's count matches it.
    expect(["reversed", "upheld"]).toContain(row.no_show_status);
    expect(await recentNoShows(flake.id, venueA)).toBe(row.no_show_status === "upheld" ? 1 : 0);
  });
});

describe("the routes", () => {
  const call = (handler: (req: NextRequest, ctx: never) => Promise<Response>, method: string, cookie: string | null, body?: unknown, ctx: unknown = undefined) =>
    handler(
      // The real path matters: a desk is turned away by the address (lib/roles.ts).
      new NextRequest(`http://localhost${handler === adminGet || handler === adminPost ? "/api/admin/no-show-marks" : handler === attention ? "/api/admin/attention" : "/api/x"}`, {
        method,
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${(++n % 250) + 1}`, ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      ctx as never
    );
  const adminCookie = async (a: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.id)).token}`;
  const userCookie = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;

  it("serve the host, the player and the reviewer, each only their own", async () => {
    const flake = await player("Route");
    const { host, game, playerId } = await played(flake);
    const hostCookie = await userCookie(host);
    const params = { params: Promise.resolve({ id: String(game.id), playerId: String(playerId) }) };
    // The host: no reason is refused with its code; with one, the mark is made; another player cannot make it.
    const noReason = await call(hostAct, "POST", hostCookie, { action: "no_show" }, params);
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toMatchObject({ code: "NS_REASON" });
    const stranger = await userCookie(await player("Other"));
    expect((await call(hostAct, "POST", stranger, { action: "no_show", reason: "Not there" }, params)).status).toBe(404);
    expect((await call(hostAct, "POST", hostCookie, { action: "no_show", reason: "Did not turn up" }, params)).status).toBe(200);

    // The player: sees it in their games and answers it; not signed in is refused; somebody else's mark is 404.
    const cookie = await userCookie(flake);
    expect((await call(myGet, "GET", null)).status).toBe(401);
    const mine = (await (await call(myGames, "GET", cookie)).json()) as { marks: { playerId: number; reason: string; canAnswer: boolean }[]; noShows: number };
    expect(mine.marks).toMatchObject([{ playerId, reason: "Did not turn up", canAnswer: true }]);
    expect(mine.noShows).toBe(1);
    expect((await call(myPost, "POST", await userCookie(await player("Third")), { playerId, answer: "Not mine" })).status).toBe(404);
    expect((await call(myPost, "POST", cookie, { playerId, answer: "x" })).status).toBe(400);
    expect((await call(myPost, "POST", cookie, { playerId, answer: "I was there at the start." })).status).toBe(200);
    expect((await call(myPost, "POST", cookie, { playerId, answer: "I was there at the start." })).status).toBe(409);
    expect(((await (await call(myGet, "GET", cookie)).json()) as { marks: { status: string }[] }).marks[0].status).toBe("disputed");

    // The reviewer: the desk is refused, another venue's manager is told 404, the venue's manager decides; unauthenticated 401.
    expect((await call(adminGet, "GET", null)).status).toBe(401);
    expect((await call(adminGet, "GET", await adminCookie(desk))).status).toBe(403);
    expect((await call(adminPost, "POST", await adminCookie(desk), { id: playerId, decision: "reverse", note: "x" })).status).toBe(403);
    const list = (await (await call(adminGet, "GET", await adminCookie(managerA))).json()) as { marks: { id: number }[] };
    expect(list.marks.some((m) => m.id === playerId)).toBe(true);
    expect(((await (await call(adminGet, "GET", await adminCookie(managerB))).json()) as { marks: { id: number }[] }).marks.some((m) => m.id === playerId)).toBe(false);
    expect((await call(adminPost, "POST", await adminCookie(managerB), { id: playerId, decision: "reverse", note: "Not mine to decide" })).status).toBe(404);
    expect((await call(adminPost, "POST", await adminCookie(managerA), { id: playerId, decision: "platform", note: "Everywhere" })).status).toBe(403);
    expect((await call(adminPost, "POST", await adminCookie(managerA), { id: playerId, decision: "reverse", note: "They were there." })).status).toBe(200);
    // The needs-attention list carries the people block for a manager, and nothing about marks for the desk.
    const att = (await (await call(attention, "GET", await adminCookie(managerA))).json()) as { people: { noShow: unknown } };
    expect(att.people.noShow).not.toBeNull();
    const deskAtt = (await (await call(attention, "GET", await adminCookie(desk))).json()) as { people: { noShow: unknown } };
    expect(deskAtt.people.noShow).toBeNull();

    // And the host takes back nothing that is already off.
    expect((await call(hostAct, "POST", hostCookie, { action: "take_back_no_show" }, params)).status).toBe(409);
  });
});
