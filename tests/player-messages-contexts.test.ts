import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, openGame } from "../src/lib/games";
import { addManaged } from "../src/lib/managed-people";
import { contextOf, candidateContexts } from "../src/lib/message-contexts";
import { saveProfile } from "../src/lib/player-profiles";
import { messageSettings, myThreads, saveMessageSettings, sendMessage, setContextMute, threadView, LIMITS } from "../src/lib/messages";
import { sendDueDigests } from "../src/lib/message-digest";
import { createBooking, listVenues } from "../src/lib/store";
import { acceptInvitation, createInviteLink, createTeam, type Team } from "../src/lib/teams";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Which contexts a message can be written in and who is in each: the same game, team and group, and the fixtures a person is in (a
 * tournament match, a box-league match, a ladder challenge, a team-league fixture), children only through a guardian's account, labelled
 * by their short name; and the one email, which says where and never what (lib/message-contexts.ts, lib/messages.ts; ADR 0039).
 */

let n = 0;
let venueId: number;
let courtId: number;
let slot = 0;

async function person(opts: { adult?: boolean; on?: boolean; name?: string } = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `${opts.name ?? "Sam"} Tan${n}`, email: `pc${n}@context.test`, phone: `01391${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: opts.adult ?? true });
  if (opts.on !== false && opts.adult !== false) {
    const done = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
    if (!done.ok) throw new Error(done.error);
  }
  return made.user;
}

async function game(host: User, players: User[] = []) {
  slot++;
  const b = await createBooking({ courtId, date: addDays(todayISO(), 3 + (slot % 8)), hours: [14 + Math.floor(slot / 8)], name: host.name, phone: host.phone, userId: host.id });
  if (!b.ok) throw new Error("booking");
  const g = await openGame(host.id, { bookingCode: b.booking.code, spots: 6, level: null, share: 0, autoAccept: true });
  if (!g.ok) throw new Error(g.error);
  for (const p of players) await askToJoin({ id: p.id, phone: p.phone }, g.game.id);
  return g.game;
}

async function team(captain: User): Promise<Team> {
  n++;
  const made = await createTeam(captain.id, { name: `Club ${n}`, sport: "badminton" });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function joinTeam(t: Team, captain: User, who: User, input: { participantId?: number } = {}) {
  const link = await createInviteLink(captain.id, t.id);
  if (!link.ok) throw new Error(link.error);
  const done = await acceptInvitation(who, new URL(link.value.link).searchParams.get("token")!, input);
  if (!done.ok) throw new Error(done.error);
}

const send = (u: User, kind: Parameters<typeof sendMessage>[1], id: number, body: string) => sendMessage(u.id, kind, id, body);

const ins = async (sql: string, ...args: unknown[]): Promise<number> => (await getDb().prepare(`${sql} RETURNING id`).get(...args) as { id: number }).id;

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  venueId = v.id;
  courtId = v.courts[0].id;
});

describe("fixtures", () => {
  it("a tournament match is a thread between its two entrants only, and ends when it is decided", async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    const day = addDays(todayISO(), 4);
    const t = await ins(
      "INSERT INTO tournaments (venue_id, name, sport, format, max_entries, starts_on, ends_on, start_min, end_min, status) VALUES (?, 'Spring Open', 'badminton', 'knockout', 8, ?, ?, 540, 1260, 'drawn')",
      venueId,
      day,
      day
    );
    const ea = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name) VALUES (?, ?, ?)", t, a.id, a.name);
    const eb = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name) VALUES (?, ?, ?)", t, b.id, b.name);
    const ec = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name) VALUES (?, ?, ?)", t, c.id, c.name);
    const m = await ins("INSERT INTO tournament_matches (tournament_id, stage, round, position, entry_a, entry_b) VALUES (?, 'knockout', 1, 1, ?, ?)", t, ea, eb);
    const other = await ins("INSERT INTO tournament_matches (tournament_id, stage, round, position, entry_a, entry_b) VALUES (?, 'knockout', 1, 2, ?, ?)", t, ec, ea);
    expect(await send(a, "tournament_match", m, "Court 2 at ten?")).toMatchObject({ ok: true });
    const seen = await threadView(b.id, "tournament_match", m);
    expect(seen).toMatchObject({ ok: true, view: { people: 1, info: { kind: "tournament_match", name: "Spring Open", venueId } } });
    // The third entrant is not in this match.
    expect(await threadView(c.id, "tournament_match", m)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    // a is in both matches: two threads, nothing shared between them.
    expect(await send(c, "tournament_match", other, "hello a")).toMatchObject({ ok: true });
    expect((await candidateContexts(a.id)).filter((x) => x.kind === "tournament_match").map((x) => x.id).sort()).toEqual([m, other].sort());
    // Withdrawn from the event: out of the match's thread at once.
    await getDb().prepare("UPDATE tournament_entries SET status = 'withdrawn' WHERE id = ?").run(eb);
    expect(await threadView(b.id, "tournament_match", m)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    await getDb().prepare("UPDATE tournament_entries SET status = 'entered' WHERE id = ?").run(eb);
    // Decided: read-only.
    await getDb().prepare("UPDATE tournament_matches SET status = 'done', winner = ?, updated_at = datetime('now') WHERE id = ?").run(ea, m);
    expect(await send(b, "tournament_match", m, "good game")).toMatchObject({ ok: false, code: "PM_READ_ONLY" });
    expect((await threadView(a.id, "tournament_match", m))).toMatchObject({ ok: true, view: { phase: "read_only" } });
  });

  it("shows a minor's entry as their guardian, by the child's short name, and a team's as its captain", async () => {
    const parent = await person();
    const rival = await person();
    const day = addDays(todayISO(), 5);
    const t = await ins(
      "INSERT INTO tournaments (venue_id, name, sport, format, max_entries, starts_on, ends_on, start_min, end_min, status) VALUES (?, 'Juniors', 'badminton', 'knockout', 8, ?, ?, 540, 1260, 'drawn')",
      venueId,
      day,
      day
    );
    const kid = await addManaged(parent.id, { displayName: "Aina Binti Lee", relationship: "parent", authority: true }, parent.name);
    if (!kid.ok) throw new Error(kid.error);
    const ea = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name, participant_id, guardian_name) VALUES (?, ?, 'Aina Binti Lee', ?, ?)", t, parent.id, kid.person.id, parent.name);
    const eb = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name) VALUES (?, ?, ?)", t, rival.id, rival.name);
    const m = await ins("INSERT INTO tournament_matches (tournament_id, stage, round, position, entry_a, entry_b) VALUES (?, 'knockout', 1, 1, ?, ?)", t, ea, eb);
    // The opponent writes to the guardian's account; there is no thread to the child, who has no account.
    expect(await send(rival, "tournament_match", m, "Shall we start at ten?")).toMatchObject({ ok: true });
    expect(await send(parent, "tournament_match", m, "Yes, we will be there")).toMatchObject({ ok: true, message: { from: { g: ["Aina L."] } } });
    const view = await threadView(rival.id, "tournament_match", m);
    if (!view.ok) throw new Error(view.error);
    expect(view.view.messages.map((x) => x.from)).toEqual([{ n: expect.stringContaining("Sam") }, { g: ["Aina L."] }]);
    // Nowhere does the child's full name appear in what is stored or shown.
    const stored = (await getDb().prepare("SELECT sender_label, body FROM player_messages WHERE thread_id IN (SELECT id FROM player_message_threads WHERE context_kind = 'tournament_match' AND context_id = ?)").all(m)) as { sender_label: string; body: string }[];
    expect(JSON.stringify([stored, view.view])).not.toContain("Binti");
    expect(JSON.stringify(stored)).not.toContain(parent.name);

    // A team entry is the captain's seat, by the team's name, and the team's other members have none.
    const cap = await person();
    const team1 = await team(cap);
    const member = await person();
    await joinTeam(team1, cap, member);
    const other = await person();
    const e1 = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name, team_id, team_name) VALUES (?, ?, ?, ?, ?)", t, cap.id, team1.name, team1.id, team1.name);
    const e2 = await ins("INSERT INTO tournament_entries (tournament_id, user_id, name) VALUES (?, ?, ?)", t, other.id, other.name);
    const m2 = await ins("INSERT INTO tournament_matches (tournament_id, stage, round, position, entry_a, entry_b) VALUES (?, 'knockout', 2, 1, ?, ?)", t, e1, e2);
    expect(await send(other, "tournament_match", m2, "good luck")).toMatchObject({ ok: true });
    const ctx = await contextOf("tournament_match", m2);
    expect(ctx!.seats.find((s) => s.userId === cap.id)!.from).toEqual({ c: team1.name });
    expect(await threadView(member.id, "tournament_match", m2)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });

  it("a box-league match, a ladder challenge and a team-league fixture are between their two sides", async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    // League.
    const league = await ins("INSERT INTO leagues (venue_id, name, sport) VALUES (?, 'Box Cup', 'badminton')", venueId);
    const season = await ins("INSERT INTO league_seasons (league_id, number, starts_on, ends_on, status) VALUES (?, 1, ?, ?, 'running')", league, todayISO(), addDays(todayISO(), 28));
    const pa = await ins("INSERT INTO league_players (league_id, user_id, name) VALUES (?, ?, ?)", league, a.id, a.name);
    const pb = await ins("INSERT INTO league_players (league_id, user_id, name) VALUES (?, ?, ?)", league, b.id, b.name);
    await ins("INSERT INTO league_players (league_id, user_id, name) VALUES (?, ?, ?)", league, c.id, c.name);
    const lm = await ins("INSERT INTO league_matches (season_id, box_no, player_a, player_b) VALUES (?, 1, ?, ?)", season, pa, pb);
    expect(await send(a, "league_match", lm, "Thursday evening?")).toMatchObject({ ok: true });
    expect(await threadView(b.id, "league_match", lm)).toMatchObject({ ok: true, view: { people: 1 } });
    expect(await threadView(c.id, "league_match", lm)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    await getDb().prepare("UPDATE league_matches SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?").run(lm);
    expect(await send(b, "league_match", lm, "thanks")).toMatchObject({ ok: false, code: "PM_READ_ONLY" });
    // A player who left the league is out of its matches.
    await getDb().prepare("UPDATE league_matches SET status = 'unplayed', updated_at = NULL WHERE id = ?").run(lm);
    await getDb().prepare("UPDATE league_players SET status = 'left' WHERE id = ?").run(pb);
    expect(await threadView(b.id, "league_match", lm)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });

    // Ladder.
    const ladder = await ins("INSERT INTO ladders (venue_id, name, sport) VALUES (?, 'Club Ladder', 'badminton')", venueId);
    const ls = await ins("INSERT INTO ladder_seasons (ladder_id, number, started_on) VALUES (?, 1, ?)", ladder, todayISO());
    const la = await ins("INSERT INTO ladder_players (ladder_id, user_id, name) VALUES (?, ?, ?)", ladder, a.id, a.name);
    const lb = await ins("INSERT INTO ladder_players (ladder_id, user_id, name) VALUES (?, ?, ?)", ladder, b.id, b.name);
    const ch = await ins("INSERT INTO ladder_challenges (ladder_id, season_id, challenger, challenged, challenger_rank, challenged_rank, created_on) VALUES (?, ?, ?, ?, 2, 1, ?)", ladder, ls, la, lb, todayISO());
    expect(await send(b, "ladder_challenge", ch, "Accepted, how about Saturday?")).toMatchObject({ ok: true });
    expect(await threadView(a.id, "ladder_challenge", ch)).toMatchObject({ ok: true });
    expect(await threadView(c.id, "ladder_challenge", ch)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    await getDb().prepare("UPDATE ladder_challenges SET status = 'declined', updated_at = datetime('now') WHERE id = ?").run(ch);
    expect(await send(a, "ladder_challenge", ch, "ok")).toMatchObject({ ok: false, code: "PM_READ_ONLY" });

    // A team league's fixture: the two captains.
    const capA = await person();
    const capB = await person();
    const tA = await team(capA);
    const tB = await team(capB);
    const tl = await ins("INSERT INTO team_leagues (venue_id, name, sport, rules, rubbers, table_rules, starts_on, ends_on) VALUES (?, 'Team Cup', 'badminton', '{}', '[]', '{}', ?, ?)", venueId, todayISO(), addDays(todayISO(), 60));
    const xa = await ins("INSERT INTO team_league_teams (league_id, team_id, name, entered_by) VALUES (?, ?, ?, ?)", tl, tA.id, tA.name, capA.id);
    const xb = await ins("INSERT INTO team_league_teams (league_id, team_id, name, entered_by) VALUES (?, ?, ?, ?)", tl, tB.id, tB.name, capB.id);
    const fx = await ins("INSERT INTO team_fixtures (league_id, round_no, home_team, away_team, date, start_min, minutes) VALUES (?, 1, ?, ?, ?, 1140, 90)", tl, xa, xb, addDays(todayISO(), 6));
    expect(await send(capA, "team_fixture", fx, "Home court is free from six")).toMatchObject({ ok: true, message: { from: { c: tA.name } } });
    expect(await threadView(capB.id, "team_fixture", fx)).toMatchObject({ ok: true, view: { people: 1, info: { venueId } } });
    // Their own team's members are not in it; neither is anybody else.
    const mate = await person();
    await joinTeam(tA, capA, mate);
    expect(await threadView(mate.id, "team_fixture", fx)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await threadView(c.id, "team_fixture", fx)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });
});

describe("children and minors", () => {
  it("a guardian is written to for a child on a team, by the child's short name, and a minor's account has no thread", async () => {
    const cap = await person();
    const t = await team(cap);
    const parent = await person({ name: "Parent" });
    const kid = await addManaged(parent.id, { displayName: "Ben Chong Wei", relationship: "parent", authority: true }, parent.name);
    if (!kid.ok) throw new Error(kid.error);
    await joinTeam(t, cap, parent, { participantId: kid.person.id });
    expect(await send(cap, "team", t.id, "Training moved to Friday")).toMatchObject({ ok: true });
    const seen = await threadView(parent.id, "team", t.id);
    expect(seen).toMatchObject({ ok: true, view: { messages: [{ body: "Training moved to Friday" }] } });
    expect(await send(parent, "team", t.id, "Thanks, Ben will be there")).toMatchObject({ ok: true, message: { from: { g: ["Ben C."] } } });
    const ctx = await contextOf("team", t.id);
    // Two seats only: the captain's and the guardian's. There is no seat for the child.
    expect(ctx!.seats.map((s) => s.userId).sort()).toEqual([cap.id, parent.id].sort());
    const stored = JSON.stringify((await getDb().prepare("SELECT sender_label FROM player_messages WHERE thread_id = (SELECT id FROM player_message_threads WHERE context_kind = 'team' AND context_id = ?)").all(t.id)));
    expect(stored).not.toContain("Chong");

    // A guardian who is also a member shows once, as both.
    const dual = await person({ name: "Dual" });
    const kid2 = await addManaged(dual.id, { displayName: "Cara Lim Mei", relationship: "parent", authority: true }, dual.name);
    if (!kid2.ok) throw new Error(kid2.error);
    await joinTeam(t, cap, dual);
    await joinTeam(t, cap, dual, { participantId: kid2.person.id });
    const both = (await contextOf("team", t.id))!.seats.find((s) => s.userId === dual.id)!;
    expect(both.from).toEqual({ n: expect.stringContaining("Dual"), g: ["Cara L."] });

    // A player who says they are under 18 has no messaging, and is in no thread even where they are a member of a group or game.
    const minor = await person({ adult: false });
    const host = await person();
    const g = await game(host, [minor]);
    expect(await messageSettings(minor.id)).toMatchObject({ enabled: false, adult: false });
    expect(await send(minor, "game", g.id, "hi")).toMatchObject({ ok: false, code: "PM_ADULTS" });
    expect(await send(host, "game", g.id, "welcome")).toMatchObject({ ok: false, code: "PM_NOBODY" });
    expect((await myThreads(minor.id)).threads).toEqual([]);
    // Saying "under 18" later switches messaging off at once, whatever was set before.
    const grown = await person();
    const host2 = await person();
    const g2 = await game(host2, [grown]);
    expect(await send(grown, "game", g2.id, "hi")).toMatchObject({ ok: true });
    await saveProfile(grown.id, { adult: false, discoverable: false, invitable: false });
    expect(await send(grown, "game", g2.id, "still me")).toMatchObject({ ok: false, code: "PM_ADULTS" });
    expect(await send(host2, "game", g2.id, "you there?")).toMatchObject({ ok: false, code: "PM_NOBODY" });
  });
});

describe("the notice email", () => {
  const notices = async (to: string) =>
    (await getDb().prepare("SELECT kind, channel, venue_id, subject, body, params, recipient FROM messages WHERE kind = 'player_message' AND recipient = ? ORDER BY id").all(to)) as {
      kind: string;
      channel: string;
      venue_id: number | null;
      subject: string;
      body: string;
      params: string;
      recipient: string;
    }[];
  /** The scheduler's tick, seven hours on: every message so far is from a period that is over (the default period is six hours). */
  const later = () => sendDueDigests({ now: Date.now() + 7 * 3_600_000, force: true });

  it("says where, never what, as one digest per thread after the period, to the people who can read it (ADR 0044 replaced the leading-edge throttle)", async () => {
    const host = await person();
    const a = await person();
    const muted = await person();
    const noEmail = await person();
    await saveMessageSettings(noEmail.id, { emailNotices: false });
    const g = await game(host, [a, muted, noEmail]);
    await setContextMute(muted.id, "game", g.id, true);
    const secret = "the-secret-word-cardamom";
    expect(await send(a, "game", g.id, `bring ${secret}`)).toMatchObject({ ok: true });
    expect(await send(a, "game", g.id, `and again ${secret}`)).toMatchObject({ ok: true });
    // Nothing at the moment of writing: the digest is the scheduler's, once the period is over.
    expect(await notices(host.email)).toHaveLength(0);
    await later();
    const mail = await notices(host.email);
    // One email for two messages, with their count.
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ kind: "player_message", channel: "email", venue_id: null });
    // Where it is, and a link into the signed-in app; never what was said.
    expect(mail[0].body).toContain(`/messages?open=game:${g.id}`);
    expect(mail[0].body).toContain("2 new messages");
    expect(mail[0].body).not.toContain(secret);
    expect(mail[0].params).not.toContain(secret);
    expect(mail[0].subject).not.toContain(secret);
    // Not to the sender, to somebody who muted the game, to somebody who turned the emails off.
    expect(await notices(a.email)).toHaveLength(0);
    expect(await notices(muted.email)).toHaveLength(0);
    expect(await notices(noEmail.email)).toHaveLength(0);
    // Never WhatsApp.
    const whatsapp = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'player_message' AND channel <> 'email'").get()) as { n: number };
    expect(whatsapp.n).toBe(0);
    // Run again, nothing more: the same messages are never told twice.
    await later();
    expect(await notices(host.email)).toHaveLength(1);
    // A new message in a later period is a digest of its own.
    await send(a, "game", g.id, "one more");
    await sendDueDigests({ now: Date.now() + 14 * 3_600_000, force: true });
    expect(await notices(host.email)).toHaveLength(2);
  });

  it("is held to a few a day for a person", async () => {
    const hosts: User[] = [];
    for (let i = 0; i < LIMITS.emailsPerDay + 1; i++) hosts.push(await person());
    const target = await person();
    for (const h of hosts) {
      const g = await game(h, [target]);
      // The target is written to by each host in a thread of its own: the daily cap leaves the last without an email.
      await send(h, "game", g.id, "welcome");
    }
    await later();
    expect(await notices(target.email)).toHaveLength(LIMITS.emailsPerDay);
  });
});

describe("what is never in a log", () => {
  it("writes no message text to the console, the activity log or the outbox", async () => {
    const lines: string[] = [];
    const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    console.log = console.error = console.warn = console.info = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const word = "pomegranate-molasses-8841x";
    try {
      const host = await person();
      const a = await person();
      const g = await game(host, [a]);
      await send(a, "game", g.id, `a ${word}`);
      const v = await threadView(host.id, "game", g.id);
      if (!v.ok) throw new Error(v.error);
      const { reportMessage } = await import("../src/lib/messages");
      await reportMessage(host.id, "game", g.id, { messageId: v.view.messages[0].id, reason: "other", note: "n" });
    } finally {
      Object.assign(console, real);
    }
    expect(lines.join("\n")).not.toContain(word);
    const outbox = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE body LIKE ? OR params LIKE ? OR subject LIKE ?").get(`%${word}%`, `%${word}%`, `%${word}%`)) as { n: number };
    expect(outbox.n).toBe(0);
    const log = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE detail LIKE ?").get(`%${word}%`)) as { n: number };
    expect(log.n).toBe(0);
  });
});
