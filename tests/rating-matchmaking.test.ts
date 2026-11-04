import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, openGame, setPlayerLevel } from "../src/lib/games";
import { recommendGames, recommendPlayers, WEIGHTS } from "../src/lib/matchmaking";
import { saveProfile } from "../src/lib/player-profiles";
import { currentStanding, earnedRatingsOf, gameReferenceRatings, matchingThreshold, poolEarned, rankingPolicy, setRankingPolicy } from "../src/lib/ratings";
import { createBooking, createVenue, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";

/**
 * Matchmaking on earned levels (lib/matchmaking.ts, lib/ratings.ts; docs/features/matchmaking.md#earned-levels): the declared level is
 * what is used unless the player chooses otherwise; an earned rating is used only if it is not provisional, and shown only if the
 * player shares it; and it never makes anybody findable who did not opt in.
 */

let n = 0;
let slot = 0;
let courtId: number;
let venueId: number;
let sport: Sport;

async function adult(level: "beginner" | "intermediate" | "advanced" | "competitive", profile: Record<string, unknown> = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `Earner ${n}`, email: `rm${n}@earned.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await setPlayerLevel(made.user.id, sport, level);
  const saved = await saveProfile(made.user.id, { adult: true, ...profile });
  if (!saved.ok) throw new Error(saved.error);
  return made.user;
}

/** A rating as the pool table holds it (what a replay of a ledger leaves there); the games decide whether it is provisional. */
async function rate(userId: number, rating: number, over: { games?: number; venue?: number; format?: "singles" | "doubles" } = {}) {
  const v = over.venue ?? venueId;
  const format = over.format ?? "doubles";
  await getDb().prepare("INSERT INTO rating_pools (venue_id, sport, format) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(v, sport, format);
  await getDb()
    .prepare("INSERT INTO rating_subjects (venue_id, sport, format, subject_kind, subject_id, rating, games, wins, draws, losses) VALUES (?, ?, ?, 'user', ?, ?, ?, 0, 0, 0)")
    .run(v, sport, format, userId, rating, over.games ?? 12);
}

async function game(host: User, over: Partial<Parameters<typeof openGame>[1]> = {}) {
  slot++;
  const made = await createBooking({ courtId, date: addDays(todayISO(), 2 + (slot % 10)), hours: [8 + Math.floor(slot / 10)], name: host.name, phone: host.phone, userId: host.id });
  if (!made.ok) throw new Error("booking");
  const opened = await openGame(host.id, { bookingCode: made.booking.code, spots: 2, level: null, share: 0, autoAccept: true, ...over });
  if (!opened.ok) throw new Error(opened.error);
  return opened.game;
}

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  venueId = v.id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

describe("which level matching uses", () => {
  it("is the one they declared unless they choose otherwise: an earned rating changes nothing by itself", async () => {
    const me = await adult("beginner");
    await rate(me.id, 1300);
    const host = await adult("intermediate");
    const beginners = await game(host, { level: "beginner" });
    const pros = await game(host, { level: "competitive" });
    const rec = await recommendGames(me.id, { limit: 50 });
    const ids = rec.games.map((g) => g.id);
    expect(ids).toContain(beginners.id);
    expect(ids).not.toContain(pros.id);
    expect(rec.excluded.LEVEL_GAP).toBeGreaterThanOrEqual(1);
    const reasons = rec.games.find((g) => g.id === beginners.id)!.match.reasons.map((r) => r.code);
    expect(reasons).toContain("LEVEL_EXACT");
    expect(reasons.some((c) => c.startsWith("LEVEL_EARNED") || c === "RATING_CLOSE")).toBe(false);
    expect(rec.basis.levelBasis).toBe("declared");
  });

  it("is the earned one when the player chooses it and the rating is not provisional, with the rating in the reason", async () => {
    const me = await adult("beginner", { levelBasis: "earned" });
    await rate(me.id, 1300);
    const host = await adult("intermediate");
    const beginners = await game(host, { level: "beginner" });
    const pros = await game(host, { level: "competitive" });
    const rec = await recommendGames(me.id, { limit: 50 });
    const ids = rec.games.map((g) => g.id);
    expect(ids).toContain(pros.id);
    expect(ids).not.toContain(beginners.id);
    const reason = rec.games.find((g) => g.id === pros.id)!.match.reasons.find((r) => r.code === "LEVEL_EARNED_EXACT")!;
    expect(reason).toEqual({ code: "LEVEL_EARNED_EXACT", points: WEIGHTS.levelExact, vars: { level: "competitive", rating: 1300 } });
    expect(rec.basis.levelBasis).toBe("earned");
  });

  it("is either: a game suiting the declared or the earned level is suggested", async () => {
    const me = await adult("beginner", { levelBasis: "either" });
    await rate(me.id, 1300);
    const host = await adult("intermediate");
    const beginners = await game(host, { level: "beginner" });
    const pros = await game(host, { level: "competitive" });
    const mid = await game(host, { level: "intermediate" });
    const ids = (await recommendGames(me.id, { limit: 50 })).games.map((g) => g.id);
    expect(ids).toContain(beginners.id);
    expect(ids).toContain(pros.id);
    // Neither the declared (beginner) nor the earned (competitive) level is one step from intermediate on both counts: one step from each.
    expect(ids).toContain(mid.id);
  });

  it("falls back to the declared level where the rating is provisional, at another venue, or in another format", async () => {
    const provisional = await adult("beginner", { levelBasis: "earned" });
    await rate(provisional.id, 1300, { games: 3 });
    const elsewhere = await adult("beginner", { levelBasis: "earned" });
    const other = await createVenue({ name: "Elsewhere Hall", area: "Klang", address: "1 Jalan Jauh", phone: "0331119999" });
    if (!other.ok) throw new Error("venue");
    await rate(elsewhere.id, 1300, { venue: other.venue.id });
    const singles = await adult("beginner", { levelBasis: "earned" });
    await rate(singles.id, 1300, { format: "singles" });
    const host = await adult("intermediate");
    const beginners = await game(host, { level: "beginner" });
    const pros = await game(host, { level: "competitive" });
    for (const who of [provisional, elsewhere, singles]) {
      const ids = (await recommendGames(who.id, { limit: 50 })).games.map((g) => g.id);
      expect(ids, who.name).toContain(beginners.id);
      expect(ids, who.name).not.toContain(pros.id);
    }
  });
});

describe("similar ratings", () => {
  it("adds a reason with both numbers and the band where the people in a game chose to show theirs and are within it", async () => {
    const me = await adult("intermediate", { levelBasis: "earned" });
    await rate(me.id, 1180);
    const sharing = await adult("intermediate", { ratingShared: true });
    await rate(sharing.id, 1215);
    const g = await game(sharing, { level: "advanced" });
    const rec = await recommendGames(me.id, { limit: 50 });
    const close = rec.games.find((x) => x.id === g.id)!.match.reasons.find((r) => r.code === "RATING_CLOSE")!;
    expect(close).toEqual({ code: "RATING_CLOSE", points: WEIGHTS.ratingClose, vars: { mine: 1180, theirs: 1215, within: 100 } });
    // Far apart: the game may still be suggested, with no such reason.
    const far = await adult("advanced", { ratingShared: true });
    await rate(far.id, 1600);
    const farGame = await game(far, { level: "advanced" });
    const farReasons = (await recommendGames(me.id, { limit: 50 })).games.find((x) => x.id === farGame.id)!.match.reasons.map((r) => r.code);
    expect(farReasons).not.toContain("RATING_CLOSE");
    // Close, but the host never chose to show it: never a hidden score.
    const private_ = await adult("intermediate");
    await rate(private_.id, 1190);
    const hidden = await game(private_, { level: "advanced" });
    const hiddenReasons = (await recommendGames(me.id, { limit: 50 })).games.find((x) => x.id === hidden.id)!.match.reasons.map((r) => r.code);
    expect(hiddenReasons).not.toContain("RATING_CLOSE");
    // And the same game, to a player who did not choose earned levels, carries no rating reason at all.
    const declared = await adult("intermediate");
    await rate(declared.id, 1180);
    const declaredReasons = (await recommendGames(declared.id, { limit: 50 })).games.find((x) => x.id === g.id)!.match.reasons.map((r) => r.code);
    expect(declaredReasons).not.toContain("RATING_CLOSE");
  });
});

describe("players suggested to a host", () => {
  it("are held to the level their rating earns where they chose it, show a number only if they share it, and are found only if they opted in", async () => {
    const host = await adult("competitive", { levelBasis: "earned" });
    await rate(host.id, 1290);
    const g = await game(host, { level: "competitive" });
    // Declared beginner, rating says competitive, chose earned; shares it.
    const sharing = await adult("beginner", { discoverable: true, levelBasis: "earned", ratingShared: true });
    await rate(sharing.id, 1300);
    // The same, but does not share it.
    const quiet = await adult("beginner", { discoverable: true, levelBasis: "earned" });
    await rate(quiet.id, 1300);
    // Declared beginner, no earned choice: not close enough to the game's level.
    const declared = await adult("beginner", { discoverable: true });
    await rate(declared.id, 1300);
    // A great rating, shared, but not discoverable: never found.
    const stranger = await adult("competitive", { levelBasis: "earned", ratingShared: true });
    await rate(stranger.id, 1310);
    const found = await recommendPlayers(host.id, g.id);
    if (!found.ok) throw new Error(found.error);
    const byId = new Map(found.players.map((p) => [p.userId, p]));
    expect(byId.has(sharing.id)).toBe(true);
    expect(byId.has(quiet.id)).toBe(true);
    expect(byId.has(declared.id)).toBe(false);
    expect(byId.has(stranger.id)).toBe(false);
    // The host sees the number of the one who shares it, with the reason; nothing of the one who does not.
    expect(byId.get(sharing.id)!.rating).toBe(1300);
    expect(byId.get(sharing.id)!.reasons).toContainEqual({ code: "RATING_CLOSE", points: WEIGHTS.ratingClose, vars: { mine: 1290, theirs: 1300, within: 100 } });
    expect(byId.get(quiet.id)!.rating).toBeUndefined();
    expect(byId.get(quiet.id)!.reasons.map((r) => r.code)).not.toContain("RATING_CLOSE");
    expect(JSON.stringify(byId.get(quiet.id))).not.toContain("1300");
    // The host sees nothing of earned numbers if they themselves chose the declared level.
    const plain = await adult("competitive");
    await rate(plain.id, 1290);
    const plainGame = await game(plain, { level: "competitive" });
    const plainFound = await recommendPlayers(plain.id, plainGame.id);
    if (!plainFound.ok) throw new Error(plainFound.error);
    expect(plainFound.players.find((p) => p.userId === sharing.id)?.reasons.map((r) => r.code) ?? []).not.toContain("RATING_CLOSE");
  });

  it("leaves blocks, adults-only and who may join as they were: a rating opens no door", async () => {
    const host = await adult("competitive", { levelBasis: "earned" });
    await rate(host.id, 1290);
    const g = await game(host, { level: "competitive" });
    const blocked = await adult("beginner", { discoverable: true, levelBasis: "earned", ratingShared: true });
    await rate(blocked.id, 1300);
    await getDb().prepare("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(host.id, blocked.id);
    const joined = await adult("beginner", { discoverable: true, levelBasis: "earned", ratingShared: true });
    await rate(joined.id, 1300);
    await askToJoin(joined, g.id);
    const found = await recommendPlayers(host.id, g.id);
    if (!found.ok) throw new Error(found.error);
    expect(found.players.map((p) => p.userId)).not.toContain(blocked.id);
    expect(found.players.map((p) => p.userId)).not.toContain(joined.id);
    // Somebody who says they are under 18 cannot share a rating, so cannot show up with one.
    const teen = await adult("beginner");
    expect(await saveProfile(teen.id, { adult: false })).toMatchObject({ ok: true });
    expect(await saveProfile(teen.id, { ratingShared: true })).toMatchObject({ ok: false, code: "RT_ADULTS_ONLY" });
  });
});

describe("matching never trusts a rating on fewer results than the install's default", () => {
  /** What matching says about a player rated on `games` results in a venue whose number is `rankAfter`: earned, or still provisional. */
  async function matched(rankAfter: number | null, games: number) {
    const set = await setRankingPolicy(venueId, { rankAfter }, "Mira Manager");
    if (!set.ok) throw new Error(set.error);
    const me = await adult("beginner", { levelBasis: "earned", ratingShared: true });
    await rate(me.id, 1300, { games });
    const host = await adult("intermediate");
    const beginners = await game(host, { level: "beginner" });
    const pros = await game(host, { level: "competitive" });
    const ids = (await recommendGames(me.id, { limit: 50 })).games.map((g) => g.id);
    const mine = await game(me, { level: "advanced" });
    return {
      me,
      // Earned: the game suited to the rating is suggested and the declared one is not; provisional: the declared level is used.
      earned: ids.includes(pros.id) && !ids.includes(beginners.id),
      declared: ids.includes(beginners.id) && !ids.includes(pros.id),
      inEarnedRatings: earnedRatingsOf(me.id).then((m) => m.has(`${venueId}|${sport}|doubles`)),
      inPool: poolEarned(venueId, sport, "doubles").then((m) => m.has(me.id)),
      inGameRef: gameReferenceRatings([{ id: mine.id, venueId, sport, spots: 2, hostId: me.id }]).then((m) => m.has(mine.id)),
    };
  }

  it("is the venue's number, never below the default: a venue at 3 still treats a 5-result player as provisional, and the declared level is used", async () => {
    try {
      const r = await matched(3, 5);
      expect(r.declared).toBe(true);
      expect(await r.inEarnedRatings).toBe(false);
      expect(await r.inPool).toBe(false);
      expect(await r.inGameRef).toBe(false);
      // Rankings, the player's own page and seeding use the venue's number as it is: ranked on three.
      expect((await rankingPolicy(venueId)).rankAfter).toBe(3);
      expect(await currentStanding(venueId, sport, "doubles", "user", r.me.id)).toMatchObject({ games: 5, provisional: false });
      // Even three results at that venue are not enough, and the default number of them are.
      const eight = await matched(3, 8);
      expect(eight.earned).toBe(true);
      expect(await eight.inEarnedRatings).toBe(true);
      expect(await eight.inPool).toBe(true);
      expect(await eight.inGameRef).toBe(true);
    } finally {
      await setRankingPolicy(venueId, { rankAfter: null }, "Mira Manager");
    }
  });

  it("is the venue's number where it is higher: a venue at 12 treats a 10-result player as provisional for matching, and trusts 12", async () => {
    try {
      const ten = await matched(12, 10);
      expect(ten.declared).toBe(true);
      expect(await ten.inEarnedRatings).toBe(false);
      expect(await ten.inPool).toBe(false);
      expect(await ten.inGameRef).toBe(false);
      const twelve = await matched(12, 12);
      expect(twelve.earned).toBe(true);
      expect(await twelve.inEarnedRatings).toBe(true);
      expect(await twelve.inPool).toBe(true);
      expect(await twelve.inGameRef).toBe(true);
    } finally {
      await setRankingPolicy(venueId, { rankAfter: null }, "Mira Manager");
    }
  });

  it("is the default 8 where the venue chose nothing, and the helper is max(venue, default)", async () => {
    const seven = await matched(null, 7);
    expect(seven.declared).toBe(true);
    expect(await seven.inPool).toBe(false);
    const eight = await matched(null, 8);
    expect(eight.earned).toBe(true);
    expect(await eight.inEarnedRatings).toBe(true);
    expect([matchingThreshold(null, 8), matchingThreshold(undefined, 8), matchingThreshold(3, 8), matchingThreshold(8, 8), matchingThreshold(12, 8), matchingThreshold(30, 8)]).toEqual([8, 8, 8, 8, 12, 30]);
  });
});
