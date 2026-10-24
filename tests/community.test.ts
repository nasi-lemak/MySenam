import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { endSeries, extendSeries, inviteRegulars, mySeries, startSeries } from "../src/lib/game-series";
import { askToJoin, gamePlayers, invitePlayer, openGame, setPlayerLevel } from "../src/lib/games";
import { closeGroup, createGroup, decideMember, groupView, GROUPS_PER_ORGANISER, inviteGroupToGame, inviteToGroup, joinGroup, leaveGroup, listGroups } from "../src/lib/groups";
import { sendMatchNotices } from "../src/lib/matchmaking";
import { saveProfile } from "../src/lib/player-profiles";
import { exportCustomerData } from "../src/lib/privacy";
import { cancelBooking, createBooking, createBookingSeries, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";

/** Community play: groups, weekly games on weekly bookings, and emails of suggested games. */

let n = 0;
let courtId: number;
let sport: Sport;
let slot = 0;

async function player(profile?: Record<string, unknown>): Promise<User> {
  n++;
  const made = await registerUser({ name: `Member ${n}`, email: `cm${n}@community.my`, phone: `01360${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (profile) {
    const saved = await saveProfile(made.user.id, profile);
    if (!saved.ok) throw new Error(saved.error);
  }
  return made.user;
}

async function hostGame(host?: User, over: Partial<Parameters<typeof openGame>[1]> = {}) {
  const h = host ?? (await player({ adult: true }));
  slot++;
  const b = await createBooking({ courtId, date: addDays(todayISO(), 2 + (slot % 9)), hours: [8 + Math.floor(slot / 9)], name: h.name, phone: h.phone, userId: h.id });
  if (!b.ok) throw new Error("booking");
  const g = await openGame(h.id, { bookingCode: b.booking.code, spots: 4, level: null, share: 5, autoAccept: false, ...over });
  if (!g.ok) throw new Error(g.error);
  return { host: h, game: g.game, booking: b.booking };
}

const memberRow = async (groupId: number, userId: number) =>
  (await getDb().prepare("SELECT id, status FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId)) as { id: number; status: string } | undefined;

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

describe("community groups", () => {
  it("are joined only with both sides agreeing, and a private one is seen only by its people", async () => {
    const organiser = await player({ adult: true });
    expect(await createGroup(organiser.id, { name: "x", sport })).toMatchObject({ ok: false });
    expect(await createGroup(organiser.id, { name: "Wednesday doubles", sport: "curling-on-mars" })).toMatchObject({ ok: false });
    const made = await createGroup(organiser.id, { name: "Wednesday doubles", sport, area: "Bangsar", capacity: 3 });
    if (!made.ok) throw new Error(made.error);
    const g = made.group;
    expect(g).toMatchObject({ members: 1, mine: { role: "organiser", status: "member" } });

    const a = await player();
    expect((await listGroups({ sport })).map((x) => x.id)).toContain(g.id);
    expect(await joinGroup(a.id, g.id)).toMatchObject({ ok: true, group: { mine: { status: "requested" }, members: 1 } });
    // Not a member yet: no roster.
    expect((await groupView(g.id, a.id))?.roster).toBeUndefined();
    const row = (await memberRow(g.id, a.id))!;
    expect(await decideMember(a.id, row.id, "accept")).toMatchObject({ ok: false, status: 404 });
    expect(await decideMember(organiser.id, row.id, "accept")).toMatchObject({ ok: true, group: { members: 2 } });
    expect((await groupView(g.id, a.id))?.roster?.map((r) => r.name)).toEqual(["Member", "Member"]);

    // Full is full.
    const b = await player();
    const c = await player();
    await joinGroup(b.id, g.id);
    await joinGroup(c.id, g.id);
    expect(await decideMember(organiser.id, (await memberRow(g.id, b.id))!.id, "accept")).toMatchObject({ ok: true });
    expect(await decideMember(organiser.id, (await memberRow(g.id, c.id))!.id, "accept")).toMatchObject({ ok: false, error: "The group is full." });
    expect(await leaveGroup(organiser.id, g.id)).toMatchObject({ ok: false });
    expect(await leaveGroup(b.id, g.id)).toMatchObject({ ok: true });

    const priv = await createGroup(organiser.id, { name: "Invite only", sport, privacy: "private" });
    if (!priv.ok) throw new Error(priv.error);
    expect(await groupView(priv.group.id, a.id)).toBeNull();
    expect((await listGroups({ viewerId: a.id })).map((x) => x.id)).not.toContain(priv.group.id);
    expect(await joinGroup(a.id, priv.group.id)).toMatchObject({ ok: false, status: 404 });
  });

  it("invite by email the same whatever the address, and never a minor out of the blue", async () => {
    const organiser = await player({ adult: true });
    const made = await createGroup(organiser.id, { name: "Futsal side", sport, privacy: "private" });
    if (!made.ok) throw new Error(made.error);
    const id = made.group.id;
    const willing = await player({ adult: true, invitable: true });
    const stranger = await player({ adult: true });
    const minor = await player({ adult: false });
    for (const email of [willing.email, stranger.email, minor.email, "nobody@nowhere.my"])
      expect(await inviteToGroup(organiser.id, id, email)).toMatchObject({ ok: true });
    expect((await memberRow(id, willing.id))?.status).toBe("invited");
    expect(await memberRow(id, stranger.id)).toBeUndefined();
    expect(await memberRow(id, minor.id)).toBeUndefined();
    // An invitation taken up is membership; the invitee sees the private group.
    expect(await groupView(id, willing.id)).toMatchObject({ id, mine: { status: "invited" } });
    expect(await joinGroup(willing.id, id)).toMatchObject({ ok: true, group: { mine: { status: "member" } } });
  });

  it("are how a player under 18 can be invited to a game, and only while the group is open", async () => {
    const organiser = await player({ adult: true });
    const made = await createGroup(organiser.id, { name: "Junior squad", sport });
    if (!made.ok) throw new Error(made.error);
    const id = made.group.id;
    const minor = await player({ adult: false });
    const { game } = await hostGame(organiser);
    expect(await invitePlayer(organiser.id, game.id, minor.id)).toMatchObject({ ok: false });
    await joinGroup(minor.id, id);
    await decideMember(organiser.id, (await memberRow(id, minor.id))!.id, "accept");
    expect(await inviteGroupToGame(organiser.id, id, game.id)).toEqual({ ok: true, invited: 1 });
    expect((await gamePlayers(game.id)).find((p) => p.userId === minor.id)).toMatchObject({ status: "invited" });

    const { game: later } = await hostGame(organiser);
    await closeGroup(organiser.id, id);
    expect(await invitePlayer(organiser.id, later.id, minor.id)).toMatchObject({ ok: false });
    expect(await inviteGroupToGame(await player().then((u) => u.id), id, later.id)).toMatchObject({ ok: false, status: 404 });
  });

  it("are closed to somebody the organiser has blocked, and capped per organiser", async () => {
    const organiser = await player({ adult: true });
    const made = await createGroup(organiser.id, { name: "Morning runners", sport });
    if (!made.ok) throw new Error(made.error);
    const pest = await player();
    await getDb().prepare("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(organiser.id, pest.id);
    expect(await joinGroup(pest.id, made.group.id)).toMatchObject({ ok: false });
    for (let i = 1; i < GROUPS_PER_ORGANISER; i++) await createGroup(organiser.id, { name: `Group ${i}`, sport });
    expect(await createGroup(organiser.id, { name: "One too many", sport })).toMatchObject({ ok: false });
  });
});

describe("weekly games", () => {
  async function weekly(host: User, weeks = 3) {
    slot++;
    const made = await createBookingSeries({ courtId, date: addDays(todayISO(), 1 + (slot % 6)), hours: [21], weeks, name: host.name, phone: host.phone, userId: host.id });
    if (!made.ok) throw new Error("series");
    return made;
  }

  it("open a game on every date of the host's weekly booking, and never a court of their own", async () => {
    const host = await player({ adult: true });
    const single = await hostGame(host);
    expect(await startSeries(host.id, { bookingCode: single.booking.code, spots: 3, level: null, share: 4, autoAccept: true })).toMatchObject({ ok: false });
    const made = await weekly(host);
    const bookingsBefore = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = ?").get(host.id)) as { n: number };
    const started = await startSeries(host.id, { bookingCode: made.bookings[0].code, title: "Thursday nights", spots: 3, level: null, share: 4, autoAccept: true, waitlist: true });
    if (!started.ok) throw new Error(started.error);
    expect(started.series.games).toHaveLength(3);
    expect(started.series.games.every((g) => g.seriesId === started.series.id && g.waitlist)).toBe(true);
    expect(await startSeries(host.id, { bookingCode: made.bookings[1].code, spots: 3, level: null, share: 4, autoAccept: true })).toMatchObject({ ok: false });
    const bookingsAfter = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = ?").get(host.id)) as { n: number };
    expect(bookingsAfter.n).toBe(bookingsBefore.n);

    // One date's booking cancelled: that date's game only.
    await cancelBooking(made.bookings[1].code, host.phone);
    const [s] = await mySeries(host.id);
    expect(s.games.map((g) => g.status)).toEqual(["open", "cancelled", "open"]);

    // A date added to the weekly booking gets its game from the scheduler.
    const extra = await weekly(host, 1);
    await getDb().prepare("UPDATE bookings SET series_code = ? WHERE id = ?").run(made.seriesCode, extra.bookings[0].id);
    expect(await extendSeries()).toBe(1);
    expect(await extendSeries()).toBe(0);
    expect((await mySeries(host.id))[0].games).toHaveLength(4);
  });

  it("invite last week's players rather than enrolling them, and end with the upcoming games called off", async () => {
    const host = await player({ adult: true });
    const made = await weekly(host, 2);
    const started = await startSeries(host.id, { bookingCode: made.bookings[0].code, spots: 3, level: null, share: 4, autoAccept: true });
    if (!started.ok) throw new Error(started.error);
    const [first, second] = started.series.games;
    const regular = await player({ adult: true });
    await askToJoin(regular, first.id);
    expect((await gamePlayers(second.id)).length).toBe(0);
    expect(await inviteRegulars(host.id, second.id)).toEqual({ ok: true, invited: 1 });
    expect((await gamePlayers(second.id))[0]).toMatchObject({ userId: regular.id, status: "invited" });
    expect(await inviteRegulars(regular.id, second.id)).toMatchObject({ ok: false, status: 404 });

    expect(await endSeries(regular.id, started.series.id)).toMatchObject({ ok: false });
    expect(await endSeries(host.id, started.series.id, true)).toEqual({ ok: true, calledOff: 2 });
    expect(await mySeries(host.id)).toEqual([]);
    const courts = (await getDb().prepare("SELECT status FROM bookings WHERE series_code = ?").all(made.seriesCode)) as { status: string }[];
    expect(courts.every((b) => b.status === "confirmed")).toBe(true);
  });
});

describe("emails of suggested games", () => {
  it("tell players who asked of each suitable game once, and never those who did not", async () => {
    const keen = await player({ adult: true, notifyMatches: "each" });
    await setPlayerLevel(keen.id, sport, "intermediate");
    const quiet = await player({ adult: true, notifyMatches: "none" });
    await setPlayerLevel(quiet.id, sport, "intermediate");
    const { game } = await hostGame(undefined, { level: "intermediate" });
    // Everybody else made in this file has been looked at just now, and the keen one told of every older game.
    await getDb().prepare("UPDATE player_profiles SET matches_checked_at = datetime('now') WHERE user_id <> ?").run(keen.id);
    await getDb().prepare("INSERT INTO match_notices (user_id, game_id) SELECT ?, id FROM open_games WHERE id <> ?").run(keen.id, game.id);
    const count = async (email: string) =>
      ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = ? AND dedupe_key LIKE 'match-notice:%'").get(email)) as { n: number }).n;

    expect(await sendMatchNotices()).toMatchObject({ emailed: 1 });
    expect(await count(keen.email)).toBe(1);
    expect(await count(quiet.email)).toBe(0);
    expect(await getDb().prepare("SELECT 1 FROM match_notices WHERE user_id = ? AND game_id = ?").get(keen.id, game.id)).toBeTruthy();
    // Not due again within the hour; and when due, nothing new, nothing sent.
    expect(await sendMatchNotices()).toMatchObject({ checked: 0 });
    await getDb().prepare("UPDATE player_profiles SET matches_checked_at = datetime('now', '-2 hours') WHERE user_id = ?").run(keen.id);
    expect(await sendMatchNotices()).toMatchObject({ emailed: 0 });
    expect(await count(keen.email)).toBe(1);
  });

  it("are in the player's data export with the rest of their matchmaking", async () => {
    const u = await player({ adult: true, area: "Cheras" });
    const data = await exportCustomerData(u.id);
    expect(data?.matchmaking).toMatchObject({ profile: { area: "Cheras", adult: 1 }, blocks: [], reportsMade: [], groups: [] });
  });
});
