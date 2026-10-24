import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  askToJoin,
  cancelGame,
  createGameLink,
  decide,
  expireHolds,
  findGames,
  gameForViewer,
  gamePlayers,
  INVITES_PER_DAY,
  inviteByEmail,
  invitePlayer,
  leaveGame,
  myGames,
  openGame,
  revokeGameLinks,
  setPlayerLevel,
} from "../src/lib/games";
import { distanceBand, recommendGames, recommendPlayers, WEIGHTS } from "../src/lib/matchmaking";
import { playerProfile, saveProfile } from "../src/lib/player-profiles";
import { blockPlayer, listPlayerReports, myBlocks, reportPlayer, reviewPlayerReport, unblockPlayer } from "../src/lib/player-safety";
import { setPlayerGender } from "../src/lib/who";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";

/**
 * Matchmaking on open games: profiles, explainable suggestions both ways,
 * private games and links, waiting lists and held places, invitations,
 * blocks and reports, and a place nobody can take twice.
 */

let n = 0;
let courtId: number;
let venue: { id: number; lat: number; lng: number; area: string };
let sport: Sport;
let slot = 0;

async function player(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `mm${n}@match.my`, phone: `01340${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** An adult who plays the venue's sport at this level, with this profile. */
async function adult(level: "beginner" | "intermediate" | "advanced" | "competitive" = "intermediate", profile: Record<string, unknown> = {}) {
  const u = await player();
  await setPlayerLevel(u.id, sport, level);
  const saved = await saveProfile(u.id, { adult: true, ...profile });
  if (!saved.ok) throw new Error(saved.error);
  return u;
}

async function hostGame(over: Partial<Parameters<typeof openGame>[1]> = {}, days?: number, by?: User) {
  const host = by ?? (await player("Host"));
  slot++;
  const made = await createBooking({
    courtId,
    // A day and hour nobody else in this file has: a given day goes in the evening.
    date: addDays(todayISO(), days ?? 2 + (slot % 10)),
    hours: [days === undefined ? 8 + Math.floor(slot / 10) : 20],
    name: host.name,
    phone: host.phone,
    userId: host.id,
  });
  if (!made.ok) throw new Error("booking");
  const opened = await openGame(host.id, { bookingCode: made.booking.code, spots: 2, level: null, share: 10, autoAccept: true, ...over });
  if (!opened.ok) throw new Error(opened.error);
  return { host, game: opened.game };
}

const statusOf = async (gameId: number, userId: number) =>
  ((await getDb().prepare("SELECT status FROM open_game_players WHERE game_id = ? AND user_id = ?").get(gameId, userId)) as { status: string } | undefined)?.status;

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  const row = (await getDb().prepare("SELECT id, lat, lng, area FROM venues WHERE id = ?").get(v.id)) as { id: number; lat: number; lng: number; area: string };
  venue = { id: row.id, lat: Number(row.lat), lng: Number(row.lng), area: row.area };
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

describe("a player's profile", () => {
  it("keeps only what matching needs, rounds the point, and lets only declared adults be found", async () => {
    const u = await player();
    expect(await playerProfile(u.id)).toMatchObject({ discoverable: false, invitable: false, adult: null, notifyMatches: "digest" });
    expect(await saveProfile(u.id, { discoverable: true })).toMatchObject({ ok: false });
    expect(await saveProfile(u.id, { adult: false, invitable: true })).toMatchObject({ ok: false });
    const saved = await saveProfile(u.id, { adult: true, discoverable: true, near: { lat: 3.139003, lng: 101.686855 }, days: [6, 0, 6], times: ["evening", "morning"], maxKm: 8 });
    expect(saved).toMatchObject({ ok: true, profile: { near: { lat: 3.14, lng: 101.69 }, days: [0, 6], times: ["morning", "evening"], maxKm: 8 } });
    expect(await saveProfile(u.id, { maxKm: 0 })).toMatchObject({ ok: false });
    expect(await saveProfile(u.id, { near: { lat: 200, lng: 0 } })).toMatchObject({ ok: false });
    // Saying they are under 18 turns off being found with it.
    expect(await saveProfile(u.id, { adult: false })).toMatchObject({ ok: false });
    expect(await saveProfile(u.id, { adult: false, discoverable: false })).toMatchObject({ ok: true, profile: { adult: false, discoverable: false } });
  });
});

describe("suggested games", () => {
  it("leaves out what the player could not join or did not ask for, and says why the rest are suggested", async () => {
    const near = { lat: venue.lat, lng: venue.lng };
    const me = await adult("intermediate", { near, maxKm: 10, maxShare: 10, intensity: "casual", times: ["morning"] });
    const good = await hostGame({ level: "intermediate", intensity: "casual", share: 8 });
    const open = await hostGame({ level: null, share: 0 });
    const tooDear = await hostGame({ share: 14 });
    const gap = await hostGame({ level: "competitive" });
    const women = await hostGame({ who: undefined });
    await getDb().prepare("UPDATE open_games SET who = 'women' WHERE id = ?").run(women.game.id);
    const adultsOnlyFull = await hostGame({ spots: 1 });
    const filler = await adult();
    await askToJoin(filler, adultsOnlyFull.game.id);
    const blockedHost = await hostGame();
    await getDb().prepare("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(blockedHost.host.id, me.id);
    const priv = await hostGame({ visibility: "private" });

    const rec = await recommendGames(me.id, { limit: 50 });
    const ids = rec.games.map((g) => g.id);
    expect(ids).toContain(good.game.id);
    expect(ids).toContain(open.game.id);
    for (const out of [tooDear, gap, women, adultsOnlyFull, blockedHost, priv]) expect(ids).not.toContain(out.game.id);
    expect(rec.excluded).toMatchObject({ OVER_BUDGET: expect.any(Number), LEVEL_GAP: expect.any(Number), WHO: expect.any(Number), FULL: expect.any(Number) });
    // A block is not told apart from a venue that will not take them.
    expect(rec.excluded.UNAVAILABLE).toBeGreaterThanOrEqual(1);
    expect(Object.keys(rec.excluded)).not.toContain("BLOCKED");

    const best = rec.games.find((g) => g.id === good.game.id)!;
    const codes = best.match.reasons.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["SPORT_YOU_PLAY", "LEVEL_EXACT", "NEAR", "INTENSITY_MATCH", "WITHIN_BUDGET"]));
    expect(best.match.score).toBe(best.match.reasons.reduce((s, r) => s + r.points, 0));
    // The point kept is rounded to about a kilometre, so "at the venue" is within one.
    const nearBy = best.match.reasons.find((r) => r.code === "NEAR")!;
    expect(nearBy).toMatchObject({ vars: { km: 2 } });
    expect(nearBy.points).toBeGreaterThanOrEqual(WEIGHTS.distanceMax - 2);
    // The exact level beats an open game otherwise alike; the order never wobbles.
    expect(ids.indexOf(good.game.id)).toBeLessThan(ids.indexOf(open.game.id));
    expect((await recommendGames(me.id, { limit: 50 })).games.map((g) => g.id)).toEqual(ids);
  });

  it("ranks by the published weights and breaks ties by the soonest", async () => {
    expect(WEIGHTS).toMatchObject({ sport: 20, levelExact: 25, levelAdjacent: 10, levelOpen: 12, distanceMax: 20, area: 12, day: 10, time: 10, intensity: 10, withinBudget: 5, waitlistOnly: -15 });
    expect([1.5, 2, 4, 9, 20, 40].map(distanceBand)).toEqual([2, 2, 5, 10, 25, 50]);
    const me = await adult("advanced", { area: venue.area });
    const later = await hostGame({ level: "advanced" }, 9);
    const sooner = await hostGame({ level: "advanced" }, 3);
    const rec = await recommendGames(me.id, { limit: 50 });
    const a = rec.games.find((g) => g.id === sooner.game.id)!;
    const b = rec.games.find((g) => g.id === later.game.id)!;
    expect(a.match.score).toBe(b.match.score);
    expect(a.match.reasons.map((r) => r.code)).toContain("IN_YOUR_AREA");
    expect(rec.games.indexOf(a)).toBeLessThan(rec.games.indexOf(b));
  });

  it("offers a full game that keeps a waiting list, below the rest, and says so", async () => {
    const me = await adult();
    const full = await hostGame({ spots: 1, waitlist: true });
    await askToJoin(await adult(), full.game.id);
    const found = (await recommendGames(me.id, { limit: 50 })).games.find((g) => g.id === full.game.id)!;
    expect(found.match.reasons).toContainEqual({ code: "WAITLIST_ONLY", points: WEIGHTS.waitlistOnly });
  });

  it("stops for somebody with too many missed games", async () => {
    const me = await adult();
    for (let i = 0; i < 3; i++) {
      const { game } = await hostGame();
      await getDb().prepare("INSERT INTO open_game_players (game_id, user_id, status, no_show) VALUES (?, ?, 'accepted', 1)").run(game.id, me.id);
    }
    expect(await recommendGames(me.id)).toMatchObject({ games: [], stopped: "NO_SHOWS" });
  });
});

describe("suggested players, for a host", () => {
  it("are only opted-in adults who fit, with a first name, a level and a distance band", async () => {
    const { host, game } = await hostGame({ level: "intermediate", share: 12 });
    const near = { lat: venue.lat + 0.02, lng: venue.lng };
    const fits = await adult("intermediate", { discoverable: true, near, maxKm: 10 });
    const hidden = await adult("intermediate", { near });
    const minor = await player();
    await setPlayerLevel(minor.id, sport, "intermediate");
    await saveProfile(minor.id, { adult: false });
    const cheap = await adult("intermediate", { discoverable: true, maxShare: 5 });
    const far = await adult("intermediate", { discoverable: true, near: { lat: venue.lat + 1, lng: venue.lng }, maxKm: 5 });
    const blocker = await adult("intermediate", { discoverable: true });
    await getDb().prepare("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(blocker.id, host.id);

    const res = await recommendPlayers(host.id, game.id, { limit: 50 });
    if (!res.ok) throw new Error(res.error);
    const ids = res.players.map((p) => p.userId);
    expect(ids).toContain(fits.id);
    for (const out of [hidden, minor, cheap, far, blocker, host]) expect(ids).not.toContain(out.id);
    const shown = res.players.find((p) => p.userId === fits.id)!;
    expect(Object.keys(shown).sort()).toEqual(["level", "name", "reasons", "score", "userId", "withinKm"]);
    expect(shown.name).not.toContain(" ");
    expect(shown.withinKm).toBe(5);
    // Not for anybody but the host.
    expect(await recommendPlayers(fits.id, game.id)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("private games and links", () => {
  it("are never listed, and open only to an invitation or a live link", async () => {
    const { host, game } = await hostGame({ visibility: "private", autoAccept: false });
    const stranger = await adult();
    expect((await findGames({ limit: 500 })).map((g) => g.id)).not.toContain(game.id);
    expect(await gameForViewer(game.id, stranger.id)).toBeNull();
    expect(await askToJoin(stranger, game.id)).toMatchObject({ ok: false, status: 404 });

    const link = await createGameLink(host.id, game.id, 24);
    if (!link.ok) throw new Error(link.error);
    expect(link.url).toContain(`game=${game.id}`);
    expect(await getDb().prepare("SELECT 1 FROM game_links WHERE token_hash = ?").get(link.token)).toBeUndefined();
    expect(await gameForViewer(game.id, stranger.id, link.token)).toMatchObject({ id: game.id });
    expect(await gameForViewer(game.id + 1000, stranger.id, link.token)).toBeNull();
    expect(await askToJoin(stranger, game.id, { link: link.token })).toMatchObject({ ok: true });
    // A link is a way in, not the host's yes.
    expect(await statusOf(game.id, stranger.id)).toBe("requested");

    expect(await revokeGameLinks(stranger.id, game.id)).toBe(0);
    expect(await revokeGameLinks(host.id, game.id)).toBe(1);
    const late = await adult();
    expect(await askToJoin(late, game.id, { link: link.token })).toMatchObject({ ok: false, status: 404 });
    const old = await createGameLink(host.id, game.id, 1);
    if (!old.ok) throw new Error(old.error);
    await getDb().prepare("UPDATE game_links SET expires_at = datetime('now', '-1 minutes') WHERE game_id = ? AND revoked_at IS NULL").run(game.id);
    expect(await gameForViewer(game.id, late.id, old.token)).toBeNull();
  });
});

describe("waiting lists and freed places", () => {
  it("holds a freed place for the next in line, passes it on when it runs out, and never twice", async () => {
    const { host, game } = await hostGame({ spots: 1, waitlist: true, autoAccept: true });
    const [a, b, c] = [await adult(), await adult(), await adult()];
    await askToJoin(a, game.id);
    expect(await askToJoin(b, game.id)).toMatchObject({ ok: true, game: { joined: 1, waiting: 1 } });
    await askToJoin(c, game.id);
    expect(await statusOf(game.id, b.id)).toBe("waitlisted");

    await leaveGame(a.id, game.id);
    expect(await statusOf(game.id, b.id)).toBe("offered");
    expect(await statusOf(game.id, c.id)).toBe("waitlisted");
    // The held place counts: nobody else gets it meanwhile.
    expect(await askToJoin(await adult(), game.id)).toMatchObject({ ok: true });
    const held = (await myGames(b.id)).playing.find((g) => g.id === game.id)!;
    expect(held.mine).toMatchObject({ status: "offered", expiresAt: expect.any(String) });

    // B lets it run out; the scheduler passes it to C, once even if run twice.
    await getDb().prepare("UPDATE open_game_players SET expires_at = datetime('now', '-1 minutes') WHERE game_id = ? AND user_id = ?").run(game.id, b.id);
    expect(await expireHolds()).toMatchObject({ offers: 1 });
    expect(await expireHolds()).toMatchObject({ offers: 0 });
    expect(await statusOf(game.id, b.id)).toBe("expired");
    expect(await statusOf(game.id, c.id)).toBe("offered");
    const offers = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE 'game-offer:%' AND recipient = ?")
      .get(c.email)) as { n: number };
    expect(offers.n).toBe(1);
    expect(await askToJoin(b, game.id)).toMatchObject({ ok: true });
    expect(await statusOf(game.id, b.id)).toBe("waitlisted");

    expect(await askToJoin(c, game.id)).toMatchObject({ ok: true, game: { joined: 1, held: 0 } });
    expect(await statusOf(game.id, c.id)).toBe("accepted");
    void host;
  });

  it("puts the next in line to a host who decides, and an offer taken after it lapsed is refused", async () => {
    const { host, game } = await hostGame({ spots: 1, waitlist: true, autoAccept: false });
    const [a, b] = [await adult(), await adult()];
    await askToJoin(a, game.id);
    const aRow = (await gamePlayers(game.id)).find((p) => p.userId === a.id)!;
    await decide(host.id, aRow.id, "accept");
    await askToJoin(b, game.id);
    expect(await statusOf(game.id, b.id)).toBe("waitlisted");
    await decide(host.id, aRow.id, "remove");
    // The host decides: B is now a request, not a held place.
    expect(await statusOf(game.id, b.id)).toBe("requested");

    const auto = await hostGame({ spots: 1, waitlist: true, autoAccept: true });
    const [x, y] = [await adult(), await adult()];
    await askToJoin(x, auto.game.id);
    await askToJoin(y, auto.game.id);
    await leaveGame(x.id, auto.game.id);
    await getDb().prepare("UPDATE open_game_players SET expires_at = datetime('now', '-1 minutes') WHERE game_id = ? AND user_id = ?").run(auto.game.id, y.id);
    expect(await askToJoin(y, auto.game.id)).toMatchObject({ ok: false, error: "The place held for you has gone to the next in line." });
    expect(await statusOf(auto.game.id, y.id)).toBe("expired");
  });

  it("turns people away from a full game without a list", async () => {
    const { game } = await hostGame({ spots: 1, waitlist: false });
    await askToJoin(await adult(), game.id);
    expect(await askToJoin(await adult(), game.id)).toMatchObject({ ok: false, error: "That game is full." });
  });
});

describe("one place, never taken twice", () => {
  it("lets exactly one of many people joining at once into the last place", async () => {
    const { game } = await hostGame({ spots: 1, autoAccept: true, waitlist: false });
    const people = await Promise.all(Array.from({ length: 6 }, () => adult()));
    const results = await Promise.all(people.map((p) => askToJoin(p, game.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "That game is full.")).toBe(true);
    const accepted = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE game_id = ? AND status = 'accepted'").get(game.id)) as { n: number };
    expect(accepted.n).toBe(1);
  });

  it("lets a host saying yes to two at once fill only the one place", async () => {
    const { host, game } = await hostGame({ spots: 1, autoAccept: false });
    const [a, b] = [await adult(), await adult()];
    await askToJoin(a, game.id);
    await askToJoin(b, game.id);
    const rows = await gamePlayers(game.id);
    const results = await Promise.all(rows.map((r) => decide(host.id, r.id, "accept")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: "The game is full." });
  });
});

describe("invitations", () => {
  it("go to people who allow them, are the host's yes, and stop working once expired or withdrawn", async () => {
    const { host, game } = await hostGame({ spots: 3, autoAccept: false });
    const open = await adult("intermediate", { invitable: true });
    const stranger = await adult();
    const minor = await player();
    await saveProfile(minor.id, { adult: false });

    expect(await invitePlayer(host.id, game.id, stranger.id)).toMatchObject({ ok: false, error: "They cannot be invited to this game." });
    expect(await invitePlayer(host.id, game.id, minor.id)).toMatchObject({ ok: false });
    expect(await invitePlayer(stranger.id, game.id, open.id)).toMatchObject({ ok: false, status: 403 });
    expect(await invitePlayer(host.id, game.id, open.id)).toMatchObject({ ok: true });
    expect(await invitePlayer(host.id, game.id, open.id)).toMatchObject({ ok: false });
    const invitedRow = (await gamePlayers(game.id)).find((p) => p.userId === open.id)!;
    expect(invitedRow).toMatchObject({ status: "invited", invited: true, expiresAt: expect.any(String) });
    // Accepting the host's invitation is in, even where the host decides.
    expect(await askToJoin(open, game.id)).toMatchObject({ ok: true });
    expect(await statusOf(game.id, open.id)).toBe("accepted");

    // Somebody who has played in their game can be invited to the next without opting in.
    const second = await hostGame({ spots: 2 });
    await askToJoin(stranger, second.game.id);
    const next = await hostGame({ spots: 2 }, undefined, second.host);
    expect(await invitePlayer(second.host.id, next.game.id, stranger.id)).toMatchObject({ ok: true });

    const withdrawn = await adult("intermediate", { invitable: true });
    await invitePlayer(host.id, game.id, withdrawn.id);
    const w = (await gamePlayers(game.id)).find((p) => p.userId === withdrawn.id)!;
    await decide(host.id, w.id, "remove");
    expect(await askToJoin(withdrawn, game.id)).toMatchObject({ ok: false, error: "The host has said no." });

    const lapsed = await adult("intermediate", { invitable: true });
    await invitePlayer(host.id, game.id, lapsed.id);
    await getDb().prepare("UPDATE open_game_players SET expires_at = datetime('now', '-1 minutes') WHERE game_id = ? AND user_id = ?").run(game.id, lapsed.id);
    expect(await askToJoin(lapsed, game.id)).toMatchObject({ ok: false, error: "That invitation has expired." });
    expect(await expireHolds()).toMatchObject({ invitations: expect.any(Number) });
  });

  it("from another player, still leave a host who decides to decide", async () => {
    const { host, game } = await hostGame({ spots: 3, autoAccept: false });
    const inside = await adult();
    await askToJoin(inside, game.id);
    await decide(host.id, (await gamePlayers(game.id))[0].id, "accept");
    const friend = await adult("intermediate", { invitable: true });
    expect(await invitePlayer(inside.id, game.id, friend.id)).toMatchObject({ ok: true });
    await askToJoin(friend, game.id);
    expect(await statusOf(game.id, friend.id)).toBe("requested");
  });

  it("by email answer the same whether or not the address can be invited, within a daily limit", async () => {
    const { host, game } = await hostGame({ spots: 10 });
    const yes = await adult("intermediate", { invitable: true });
    const no = await adult();
    const a = await inviteByEmail(host.id, game.id, yes.email.toUpperCase());
    const b = await inviteByEmail(host.id, game.id, no.email);
    const c = await inviteByEmail(host.id, game.id, "nobody@nowhere.my");
    for (const r of [a, b, c]) expect(r.ok).toBe(true);
    expect(await statusOf(game.id, yes.id)).toBe("invited");
    expect(await statusOf(game.id, no.id)).toBeUndefined();

    await getDb()
      .prepare(
        `INSERT INTO open_game_players (game_id, user_id, status, invited_by, created_at)
         SELECT ?, id, 'expired', ?, datetime('now') FROM users WHERE id NOT IN (SELECT user_id FROM open_game_players WHERE game_id = ?) LIMIT ?`
      )
      .run(game.id, host.id, game.id, INVITES_PER_DAY);
    const more = await adult("intermediate", { invitable: true });
    expect(await invitePlayer(host.id, game.id, more.id)).toMatchObject({ ok: false, status: 429 });
  });
});

describe("blocks and reports", () => {
  it("keep blocked people out of each other's games, in words that do not give the block away", async () => {
    const { host, game } = await hostGame({ spots: 3, autoAccept: false });
    const pest = await adult();
    // Not somebody they have come across: nothing to block.
    expect(await blockPlayer(host.id, pest.id)).toMatchObject({ ok: false, status: 404 });
    await askToJoin(pest, game.id);
    expect(await blockPlayer(host.id, pest.id)).toMatchObject({ ok: true });
    // What they asked is turned down; asking again is refused like a closed game.
    expect(await statusOf(game.id, pest.id)).toBe("declined");
    const other = await hostGame({ spots: 3 });
    await askToJoin(host, other.game.id);
    expect(await askToJoin(pest, other.game.id)).toMatchObject({ ok: false, error: "That game is not taking players." });
    expect(await myBlocks(host.id)).toEqual([expect.objectContaining({ userId: pest.id, name: pest.name.split(" ")[0] })]);
    await unblockPlayer(host.id, pest.id);
    expect(await askToJoin(pest, other.game.id)).toMatchObject({ ok: true });
  });

  it("go to the owners, once per person, from people who have come across each other", async () => {
    const { host, game } = await hostGame({ spots: 3 });
    const p = await adult();
    const unrelated = await adult();
    await askToJoin(p, game.id);
    expect(await reportPlayer(unrelated.id, { userId: p.id, reason: "abuse" })).toMatchObject({ ok: false, status: 404 });
    expect(await reportPlayer(host.id, { userId: p.id, reason: "nonsense" })).toMatchObject({ ok: false });
    expect(await reportPlayer(host.id, { userId: p.id, gameId: game.id, reason: "no_show", note: "Did not come" })).toMatchObject({ ok: true });
    expect(await reportPlayer(host.id, { userId: p.id, reason: "abuse" })).toMatchObject({ ok: true });
    const open = await listPlayerReports({ status: "open" });
    const mine = open.filter((r) => r.reported?.id === p.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ reason: "no_show", note: "Did not come", gameId: game.id, reporter: { id: host.id } });
    expect(await reviewPlayerReport(mine[0].id)).toBe(true);
    expect(await reviewPlayerReport(mine[0].id)).toBe(false);
  });
});

describe("a host's own game", () => {
  it("is theirs alone to run, and calling it off tells everybody without touching the court", async () => {
    const { host, game } = await hostGame({ spots: 2, waitlist: true });
    const other = await hostGame();
    const a = await adult();
    await askToJoin(a, game.id);
    const row = (await gamePlayers(game.id))[0];
    expect(await decide(other.host.id, row.id, "remove")).toMatchObject({ ok: false, status: 404 });
    expect(await cancelGame(other.host.id, game.id)).toMatchObject({ ok: false, status: 404 });
    expect(await cancelGame(host.id, game.id)).toMatchObject({ ok: true, game: { status: "cancelled" } });
    const booking = (await getDb().prepare("SELECT b.status FROM bookings b JOIN open_games g ON g.booking_id = b.id WHERE g.id = ?").get(game.id)) as { status: string };
    expect(booking.status).toBe("confirmed");
    const told = (await getDb().prepare("SELECT subject FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 1").get(a.email)) as { subject: string };
    expect(told.subject).toMatch(/called off/);
    expect(await askToJoin(await adult(), game.id)).toMatchObject({ ok: false });
  });

  it("can be adults only, on the player's own word", async () => {
    const { game } = await hostGame({ adultsOnly: true });
    const unsaid = await player();
    expect(await askToJoin(unsaid, game.id)).toMatchObject({ ok: false, code: "ADULTS_ONLY" });
    await saveProfile(unsaid.id, { adult: true });
    expect(await askToJoin(unsaid, game.id)).toMatchObject({ ok: true });
  });

  it("keeps a women-only rule in suggestions as in joining", async () => {
    const woman = await adult();
    await setPlayerGender(woman.id, "woman");
    const { game } = await hostGame();
    await getDb().prepare("UPDATE open_games SET who = 'women' WHERE id = ?").run(game.id);
    expect((await recommendGames(woman.id, { limit: 50 })).games.map((g) => g.id)).toContain(game.id);
  });
});
