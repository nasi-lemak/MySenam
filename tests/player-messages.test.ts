import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { cancelGame, askToJoin, decide, leaveGame, openGame } from "../src/lib/games";
import { closeGroup, createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { blockedBetween, unblockPlayer } from "../src/lib/player-safety";
import { saveProfile } from "../src/lib/player-profiles";
import { cutoffFor, pruneMessages } from "../src/lib/message-privacy";
import { LIMITS, contactDetail, messageSettings, myThreads, reportMessage, saveMessageSettings, sendMessage, setContextMute, threadView, blockSender, unreadCount } from "../src/lib/messages";
import { createBooking, listVenues } from "../src/lib/store";
import { acceptInvitation, archiveTeam, createInviteLink, createTeam, leaveTeam, type Team } from "../src/lib/teams";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";

/**
 * Messages between players (lib/messages.ts; migration 0280; ADR 0039): only inside a context people share, adults who turned it on,
 * text only and no contact details, limits, blocks that say nothing, reports that freeze a copy, notices with no text in them.
 */

let n = 0;
let courtId: number;
let sport: Sport;
let slot = 0;

async function person(opts: { adult?: boolean | null; on?: boolean; name?: string } = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `${opts.name ?? "Pat"} Lee${n}`, email: `pm${n}@messages.test`, phone: `01390${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (opts.adult !== null) await saveProfile(made.user.id, { adult: opts.adult ?? true });
  if (opts.on !== false && opts.adult !== false && opts.adult !== null) {
    const done = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
    if (!done.ok) throw new Error(done.error);
  }
  return made.user;
}

/** A game at a free court on a day to come, with these players accepted. */
async function game(host: User, players: User[] = []) {
  slot++;
  const b = await createBooking({ courtId, date: addDays(todayISO(), 2 + (slot % 9)), hours: [8 + Math.floor(slot / 9)], name: host.name, phone: host.phone, userId: host.id });
  if (!b.ok) throw new Error("booking");
  const g = await openGame(host.id, { bookingCode: b.booking.code, spots: 6, level: null, share: 0, autoAccept: true });
  if (!g.ok) throw new Error(g.error);
  for (const p of players) {
    const joined = await askToJoin({ id: p.id, phone: p.phone }, g.game.id);
    if (!joined.ok) throw new Error(joined.error);
  }
  return g.game;
}

const send = (u: User, kind: Parameters<typeof sendMessage>[1], id: number, body: string) => sendMessage(u.id, kind, id, body);
const texts = async (u: User, kind: Parameters<typeof threadView>[1], id: number) => {
  const v = await threadView(u.id, kind, id);
  if (!v.ok) throw new Error(v.error);
  return v.view.messages.map((m) => m.body);
};

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

describe("who can message, and when", () => {
  it("is off until a declared adult turns it on after the first screen, and joining a game does not", async () => {
    const adult = await person({ on: false });
    expect(await messageSettings(adult.id)).toMatchObject({ enabled: false, adult: true, explained: false });
    expect(await saveMessageSettings(adult.id, { enabled: true })).toMatchObject({ ok: false, code: "PM_UNDERSTOOD" });
    expect(await saveMessageSettings(adult.id, { enabled: true, understood: true })).toMatchObject({ ok: true, settings: { enabled: true, explained: true } });
    // The first screen is not asked again once seen.
    await saveMessageSettings(adult.id, { enabled: false });
    expect(await saveMessageSettings(adult.id, { enabled: true })).toMatchObject({ ok: true, settings: { enabled: true } });

    const minor = await person({ adult: false });
    expect(await saveMessageSettings(minor.id, { enabled: true, understood: true })).toMatchObject({ ok: false, code: "PM_ADULTS" });
    const unsaid = await person({ adult: null });
    expect(await saveMessageSettings(unsaid.id, { enabled: true, understood: true })).toMatchObject({ ok: false, code: "PM_ADULTS" });

    // Joining a game turns nothing on.
    const host = await person();
    const joiner = await person({ on: false });
    await game(host, [joiner]);
    expect((await messageSettings(joiner.id)).enabled).toBe(false);
  });

  it("opens a thread in a game only between people who both have it on, and shows nobody who has it off", async () => {
    const host = await person();
    const a = await person();
    const off = await person({ on: false });
    const g = await game(host, [a, off]);
    // Somebody with it off cannot read or write, and is told why.
    expect(await send(off, "game", g.id, "hello")).toMatchObject({ ok: false, code: "PM_OFF" });
    expect(await threadView(off.id, "game", g.id)).toMatchObject({ ok: false, code: "PM_OFF" });
    // Host and player both on: a thread begins with the first message.
    expect(await send(a, "game", g.id, "I will bring the balls")).toMatchObject({ ok: true, message: { mine: true, from: { n: expect.stringContaining("Pat") } } });
    expect(await texts(host, "game", g.id)).toEqual(["I will bring the balls"]);
    // The one who has it off never sees it, even though they are in the game.
    expect(await threadView(off.id, "game", g.id)).toMatchObject({ ok: false });
    expect((await myThreads(off.id)).threads).toEqual([]);
  });

  it("refuses somebody who is not in the context as if it did not exist, for every context kind", async () => {
    const host = await person();
    const a = await person();
    const stranger = await person();
    const g = await game(host, [a]);
    expect(await send(stranger, "game", g.id, "hi")).toMatchObject({ ok: false, code: "PM_NOT_FOUND", status: 404 });
    expect(await threadView(stranger.id, "game", g.id)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await threadView(stranger.id, "game", 987654)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    for (const kind of ["team", "group", "tournament_match", "league_match", "ladder_challenge", "team_fixture"] as const)
      expect(await threadView(stranger.id, kind, 987654), kind).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    // A person who asked to join but was not let in is not in it.
    const pending = await person();
    const closed = await openGame(host.id, { bookingCode: (await createBooking({ courtId, date: addDays(todayISO(), 12), hours: [20], name: host.name, phone: host.phone, userId: host.id }).then((b) => (b.ok ? b.booking.code : "")))!, spots: 2, level: null, share: 0, autoAccept: false });
    if (!closed.ok) throw new Error(closed.error);
    await askToJoin({ id: pending.id, phone: pending.phone }, closed.game.id);
    expect(await threadView(pending.id, "game", closed.game.id)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });

  it("lists only the contexts a person is in, with somebody to write to, and nothing at all without a thread and nobody else on", async () => {
    const host = await person();
    const lonely = await game(host);
    expect((await myThreads(host.id)).threads.map((t) => t.id)).not.toContain(lonely.id);
    const a = await person();
    const g = await game(host, [a]);
    const mine = await myThreads(host.id);
    expect(mine.threads.find((t) => t.kind === "game" && t.id === g.id)).toMatchObject({ people: 1, unread: 0 });
    // A stranger has none.
    expect((await myThreads((await person()).id)).threads).toEqual([]);
  });
});

describe("what a message is", () => {
  it("is text, trimmed, within a length, with no phone number or email address", async () => {
    const host = await person();
    const a = await person();
    const g = await game(host, [a]);
    expect(await send(a, "game", g.id, "   ")).toMatchObject({ ok: false, code: "PM_EMPTY" });
    expect(await send(a, "game", g.id, "x".repeat(LIMITS.maxLength + 1))).toMatchObject({ ok: false, code: "PM_LONG", vars: { n: LIMITS.maxLength } });
    expect(await send(a, "game", g.id, "x".repeat(LIMITS.maxLength))).toMatchObject({ ok: true });
    for (const bad of ["call me 012-345 6789", "+60 12 345 6789", "mail me at pat@example.com", "0123456789", "(03) 1234 5678"])
      expect(await send(a, "game", g.id, bad), bad).toMatchObject({ ok: false, code: "PM_CONTACT" });
    // Scores, times and a court number are not telephone numbers.
    for (const fine of ["we won 21-19 21-17", "court 3 at 8:30, bring 12 balls", "see you at 19:00 on 14/11"])
      expect(await send(a, "game", g.id, fine), fine).toMatchObject({ ok: true });
    // Control characters are taken out and the kept text is what the other side reads.
    await send(a, "game", g.id, "line one\r\n\r\n\r\n\r\nline\u0007 two  ");
    const seen = await texts(host, "game", g.id);
    expect(seen[seen.length - 1]).toBe("line one\n\nline two");
    expect(contactDetail("a link: https://example.com/court")).toBeNull();
  });

  it("has no way to send a file, picture or a link that opens", async () => {
    // The only text a message carries is its body; there is no attachment column, and a link is stored as the text it is.
    const cols = (await getDb().prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'player_messages' ORDER BY ordinal_position").all()) as { column_name: string }[];
    // `hidden_at` / `hidden_by` (migration 0286): a supervisor of a youth group removing a message; still no attachment.
    expect(cols.map((c) => c.column_name)).toEqual(["id", "thread_id", "sender_id", "sender_label", "body", "removed_at", "created_at", "hidden_at", "hidden_by"]);
  });
});

describe("limits", () => {
  it("holds a person to messages an hour, into one thread an hour, and new conversations a day", async () => {
    const host = await person();
    const a = await person();
    const g = await game(host, [a]);
    for (let i = 0; i < LIMITS.perThreadPerHour; i++) expect(await send(a, "game", g.id, `m${i}`)).toMatchObject({ ok: true });
    expect(await send(a, "game", g.id, "one more")).toMatchObject({ ok: false, code: "PM_RATE", status: 429 });
    // The same person into another thread an hour: allowed, until their hour is full.
    const other = await person();
    const g2 = await game(host, [other]);
    for (let i = 0; i < LIMITS.perHour - LIMITS.perThreadPerHour; i++) expect(await send(host, "game", g2.id, `h${i}`)).toMatchObject({ ok: true });
    // Host has sent only perHour - perThreadPerHour here; the person above (a) is at their thread's limit but not their hour's.
    const g3 = await game(host, [a]);
    expect(await send(a, "game", g3.id, "elsewhere")).toMatchObject({ ok: true });
  });

  it("holds new conversations to a few a day", async () => {
    const a = await person();
    const hosts: User[] = [];
    for (let i = 0; i <= LIMITS.newThreadsPerDay; i++) hosts.push(await person());
    let refused = 0;
    for (const h of hosts) {
      const g = await game(h, [a]);
      const r = await send(a, "game", g.id, "hello");
      if (!r.ok) {
        expect(r).toMatchObject({ code: "PM_NEW_THREADS" });
        refused++;
        // The refused one left nothing behind.
        expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE context_kind = 'game' AND context_id = ?").get(g.id)) as { n: number }).n).toBe(0);
      }
    }
    expect(refused).toBe(1);
  });
});

describe("a context's end", () => {
  it("is read-only for fourteen days after a game is called off, then closed, then removed by retention", async () => {
    const host = await person();
    const a = await person();
    const g = await game(host, [a]);
    await send(a, "game", g.id, "see you");
    expect((await cancelGame(host.id, g.id)).ok).toBe(true);
    // Called off: nobody may write; both can still read.
    expect(await send(a, "game", g.id, "oh no")).toMatchObject({ ok: false, code: "PM_READ_ONLY" });
    const v = await threadView(host.id, "game", g.id);
    expect(v).toMatchObject({ ok: true, view: { phase: "read_only", canSend: false, whyNot: "PM_READ_ONLY" } });
    const db = getDb();
    const row = (await db.prepare("SELECT id, ended_at FROM player_message_threads WHERE context_kind = 'game' AND context_id = ?").get(g.id)) as { id: number; ended_at: string | null };
    expect(row.ended_at).not.toBeNull();
    // Fourteen days on: closed, not readable, no longer listed.
    await db.prepare("UPDATE player_message_threads SET ended_at = ? WHERE id = ?").run(`${addDays(todayISO(), -(LIMITS.readOnlyDays + 1))} 10:00:00`, row.id);
    expect(await threadView(host.id, "game", g.id)).toMatchObject({ ok: false, code: "PM_CLOSED" });
    expect((await myThreads(host.id)).threads.map((t) => t.id)).not.toContain(g.id);
    // Kept for the install's period after the end, then deleted with its messages.
    await pruneMessages(cutoffFor(90).slice(0, 10));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE id = ?").get(row.id)) as { n: number }).n).toBe(1);
    await db.prepare("UPDATE player_message_threads SET ended_at = ? WHERE id = ?").run(`${addDays(todayISO(), -91)} 10:00:00`, row.id);
    await pruneMessages(cutoffFor(90).slice(0, 10));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE id = ?").get(row.id)) as { n: number }).n).toBe(0);
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_messages WHERE thread_id = ?").get(row.id)) as { n: number }).n).toBe(0);
  });

  it("ends a group's thread when the group is closed, and a team's when it is archived", async () => {
    const org = await person();
    const m = await person();
    const made = await createGroup(org.id, { name: "Wednesday crowd", sport });
    if (!made.ok) throw new Error(made.error);
    expect((await joinGroup(m.id, made.group.id)).ok).toBe(true);
    const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(made.group.id, m.id)) as { id: number };
    expect((await decideMember(org.id, row.id, "accept")).ok).toBe(true);
    expect(await send(m, "group", made.group.id, "Wednesday?")).toMatchObject({ ok: true });
    expect(await texts(org, "group", made.group.id)).toEqual(["Wednesday?"]);
    expect((await closeGroup(org.id, made.group.id)).ok).toBe(true);
    expect(await send(org, "group", made.group.id, "bye")).toMatchObject({ ok: false, code: "PM_READ_ONLY" });

    const captain = await person();
    const t = await team(captain);
    const mate = await person();
    await joinTeam(t, captain, mate);
    expect(await send(mate, "team", t.id, "practice at 7")).toMatchObject({ ok: true });
    expect((await archiveTeam(captain.id, t.id)).ok).toBe(true);
    expect(await send(captain, "team", t.id, "season over")).toMatchObject({ ok: false, code: "PM_READ_ONLY" });
  });
});

async function team(captain: User): Promise<Team> {
  n++;
  const made = await createTeam(captain.id, { name: `Court Club ${n}`, sport: "badminton" });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function joinTeam(t: Team, captain: User, who: User) {
  const link = await createInviteLink(captain.id, t.id);
  if (!link.ok) throw new Error(link.error);
  const done = await acceptInvitation(who, new URL(link.value.link).searchParams.get("token")!, {});
  if (!done.ok) throw new Error(done.error);
}

describe("teams and leaving", () => {
  it("is the team's members while they are members, and a member who leaves is out at once", async () => {
    const captain = await person();
    const a = await person();
    const b = await person();
    const t = await team(captain);
    await joinTeam(t, captain, a);
    await joinTeam(t, captain, b);
    expect(await send(a, "team", t.id, "who is in on Tuesday?")).toMatchObject({ ok: true });
    expect(await texts(b, "team", t.id)).toEqual(["who is in on Tuesday?"]);
    expect((await leaveTeam(a.id, t.id)).ok).toBe(true);
    expect(await send(a, "team", t.id, "I left")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await threadView(a.id, "team", t.id)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    // The others still read what they were sent.
    expect(await texts(b, "team", t.id)).toEqual(["who is in on Tuesday?"]);
  });

  it("is a game's players while they are accepted: leaving takes the thread away", async () => {
    const host = await person();
    const a = await person();
    const g = await game(host, [a]);
    expect(await send(host, "game", g.id, "welcome")).toMatchObject({ ok: true });
    expect(await texts(a, "game", g.id)).toEqual(["welcome"]);
    expect((await leaveGame(a.id, g.id)).ok).toBe(true);
    expect(await threadView(a.id, "game", g.id)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });

  it("removes somebody the host removes", async () => {
    const host = await person();
    const a = await person();
    const g = await game(host, [a]);
    const row = (await getDb().prepare("SELECT id FROM open_game_players WHERE game_id = ? AND user_id = ?").get(g.id, a.id)) as { id: number };
    expect((await decide(host.id, row.id, "remove")).ok).toBe(true);
    expect(await send(a, "game", g.id, "hello?")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });
});

describe("blocking, muting, reading", () => {
  it("delivers nothing between people who blocked one another, and tells neither", async () => {
    const host = await person();
    const a = await person();
    const b = await person();
    const g = await game(host, [a, b]);
    await send(a, "game", g.id, "from a");
    const first = await threadView(b.id, "game", g.id);
    if (!first.ok) throw new Error(first.error);
    expect(await blockSender(b.id, "game", g.id, first.view.messages[0].id)).toMatchObject({ ok: true });
    expect(await blockedBetween(a.id, b.id)).toBe(true);
    // b no longer sees a's earlier message, nor a's later ones; a sees their own, and b's silence.
    await send(a, "game", g.id, "from a again");
    expect(await texts(b, "game", g.id)).toEqual([]);
    expect(await send(b, "game", g.id, "from b")).toMatchObject({ ok: true });
    expect(await texts(a, "game", g.id)).toEqual(["from a", "from a again"]);
    // The host reads everybody's.
    expect(await texts(host, "game", g.id)).toEqual(["from a", "from a again", "from b"]);
    await unblockPlayer(b.id, a.id);
    expect(await texts(b, "game", g.id)).toEqual(["from a", "from a again", "from b"]);
    // Cannot block yourself, or a message that is not in a thread you read.
    expect(await blockSender(b.id, "game", g.id, first.view.messages[0].id + 9999)).toMatchObject({ ok: false });
    const mine = await threadView(b.id, "game", g.id);
    if (!mine.ok) throw new Error(mine.error);
    expect(await blockSender(b.id, "game", g.id, mine.view.messages.find((m) => m.mine)!.id)).toMatchObject({ ok: false, code: "PM_OWN" });
  });

  it("is not a way to find somebody: blocking works only inside a thread you can read", async () => {
    const host = await person();
    const a = await person();
    const outsider = await person();
    const g = await game(host, [a]);
    await send(a, "game", g.id, "hi");
    const v = await threadView(host.id, "game", g.id);
    if (!v.ok) throw new Error(v.error);
    expect(await blockSender(outsider.id, "game", g.id, v.view.messages[0].id)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await blockedBetween(a.id, outsider.id)).toBe(false);
  });

  it("counts unread, marks read, and leaves a muted context out of the badge", async () => {
    const host = await person();
    const a = await person();
    const g = await game(host, [a]);
    await send(a, "game", g.id, "one");
    await send(a, "game", g.id, "two");
    expect((await myThreads(host.id)).threads.find((t) => t.id === g.id)).toMatchObject({ unread: 2, muted: false });
    expect(await unreadCount(host.id)).toBe(2);
    // Polling: only what came after.
    const v = await threadView(host.id, "game", g.id, { after: 0, markRead: true });
    if (!v.ok) throw new Error(v.error);
    expect(v.view.messages).toHaveLength(2);
    expect(await unreadCount(host.id)).toBe(0);
    await send(a, "game", g.id, "three");
    expect(await unreadCount(host.id)).toBe(1);
    expect(await setContextMute(host.id, "game", g.id, true)).toMatchObject({ ok: true, muted: true });
    expect(await unreadCount(host.id)).toBe(0);
    expect((await myThreads(host.id)).threads.find((t) => t.id === g.id)).toMatchObject({ unread: 1, muted: true });
    const after = await threadView(host.id, "game", g.id, { after: v.view.latestId });
    if (!after.ok) throw new Error(after.error);
    expect(after.view.messages.map((m) => m.body)).toEqual(["three"]);
    expect(await setContextMute(host.id, "game", g.id, false)).toMatchObject({ ok: true, muted: false });
  });
});

describe("reports", () => {
  it("freeze a copy of the thread as the reporter saw it, once, and suspend somebody three people reported", async () => {
    const host = await person();
    const bad = await person({ name: "Bad" });
    const a = await person();
    const b = await person();
    const g = await game(host, [bad, a, b]);
    await send(a, "game", g.id, "morning all");
    await send(bad, "game", g.id, "you are all useless");
    await send(b, "game", g.id, "hey, be nice");
    const v = await threadView(a.id, "game", g.id);
    if (!v.ok) throw new Error(v.error);
    const target = v.view.messages.find((m) => m.body === "you are all useless")!;
    expect(await reportMessage(a.id, "game", g.id, { messageId: target.id, reason: "nonsense" })).toMatchObject({ ok: false, code: "PM_REASON" });
    expect(await reportMessage(a.id, "game", g.id, { messageId: v.view.messages[0].id, reason: "abuse" })).toMatchObject({ ok: false, code: "PM_OWN" });
    expect(await reportMessage(a.id, "game", g.id, { messageId: target.id, reason: "abuse", note: "rude" })).toMatchObject({ ok: true, suspended: false });
    // Twice is once.
    expect(await reportMessage(a.id, "game", g.id, { messageId: target.id, reason: "abuse" })).toMatchObject({ ok: true });
    const db = getDb();
    const reports = (await db.prepare("SELECT id, venue_id, status FROM player_message_reports WHERE reported_id = ?").all(bad.id)) as { id: number; venue_id: number | null; status: string }[];
    expect(reports).toHaveLength(1);
    expect(reports[0].venue_id).not.toBeNull();
    const lines = (await db.prepare("SELECT body, flagged FROM player_message_report_lines WHERE report_id = ? ORDER BY id").all(reports[0].id)) as { body: string; flagged: number }[];
    expect(lines).toEqual([
      { body: "morning all", flagged: 0 },
      { body: "you are all useless", flagged: 1 },
      { body: "hey, be nice", flagged: 0 },
    ]);
    // The copy stands though the thread is later removed.
    // Three different people: the rule suspends their messaging everywhere, pending the owner's review.
    expect(await reportMessage(b.id, "game", g.id, { messageId: target.id, reason: "abuse" })).toMatchObject({ ok: true, suspended: false });
    expect(await reportMessage(host.id, "game", g.id, { messageId: target.id, reason: "safety" })).toMatchObject({ ok: true, suspended: true });
    expect(await send(bad, "game", g.id, "I am still here")).toMatchObject({ ok: false, code: "PM_SUSPENDED" });
    // They can still read.
    expect((await threadView(bad.id, "game", g.id)).ok).toBe(true);
    const susp = (await db.prepare("SELECT source, venue_id, lifted_at FROM player_message_suspensions WHERE user_id = ?").all(bad.id)) as { source: string; venue_id: number | null; lifted_at: string | null }[];
    expect(susp).toEqual([{ source: "automatic", venue_id: null, lifted_at: null }]);
    // Only somebody who can read the message can report it; a stranger finds nothing.
    const stranger = await person();
    expect(await reportMessage(stranger.id, "game", g.id, { messageId: target.id, reason: "abuse" })).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });

  it("does not count a report found to need no action", async () => {
    const host = await person();
    const odd = await person();
    const g = await game(host, [odd]);
    await send(odd, "game", g.id, "hello there");
    const v = await threadView(host.id, "game", g.id);
    if (!v.ok) throw new Error(v.error);
    await reportMessage(host.id, "game", g.id, { messageId: v.view.messages[0].id, reason: "spam" });
    await getDb().prepare("UPDATE player_message_reports SET status = 'reviewed', outcome = 'no_action', reviewed_at = datetime('now') WHERE reported_id = ?").run(odd.id);
    const x = await person();
    const y = await person();
    const g2 = await game(host, [odd, x, y]);
    await send(odd, "game", g2.id, "again");
    const w = await threadView(x.id, "game", g2.id);
    if (!w.ok) throw new Error(w.error);
    const id = w.view.messages[0].id;
    expect(await reportMessage(x.id, "game", g2.id, { messageId: id, reason: "spam" })).toMatchObject({ ok: true, suspended: false });
    // host (dismissed once), x, y: the dismissed one does not count, so two live reports are not three.
    expect(await reportMessage(y.id, "game", g2.id, { messageId: id, reason: "spam" })).toMatchObject({ ok: true, suspended: false });
  });
});
