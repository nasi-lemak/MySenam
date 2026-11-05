import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, openGame } from "../src/lib/games";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { digestHours, sendDueDigests } from "../src/lib/message-digest";
import { saveMessageSettings, sendMessage, setContextMute, threadView } from "../src/lib/messages";
import { tickOutbox } from "../src/lib/notify";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";
import { markYouthGroup, setConsent, setGuardianNoticeMode, setMinorOptIn, setYouthAdult } from "../src/lib/youth-messages";

/**
 * The digest that replaced the leading-edge throttle (lib/message-digest.ts; ADR 0044): one email per person per conversation per period,
 * with the count and never the text, sent by the scheduler once the period of the messages is over, only for what is still unread; each
 * person's choice (at once, a digest, daily); a guardian's choice governing a child's notices; and nothing sent twice.
 */

let n = 0;
let courtId: number;
let sport: Sport;
let slot = 0;

async function adult(name = "Pat", mode?: "immediate" | "digest" | "daily"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Lee${n}`, email: `dg${n}@digest.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true, ...(mode ? { noticeMode: mode } : {}) });
  if (!on.ok) throw new Error(on.error);
  return made.user;
}

async function game(host: User, players: User[]) {
  slot++;
  const b = await createBooking({ courtId, date: addDays(todayISO(), 2 + (slot % 9)), hours: [8 + Math.floor(slot / 9)], name: host.name, phone: host.phone, userId: host.id });
  if (!b.ok) throw new Error("booking");
  const g = await openGame(host.id, { bookingCode: b.booking.code, spots: 6, level: null, share: 0, autoAccept: true });
  if (!g.ok) throw new Error(g.error);
  for (const p of players) await askToJoin({ id: p.id, phone: p.phone }, g.game.id);
  return g.game;
}

const notices = async (email: string) =>
  (await getDb().prepare("SELECT body, subject, params, channel FROM messages WHERE kind = 'player_message' AND recipient = ? ORDER BY id").all(email)) as { body: string; subject: string; params: string; channel: string }[];

/** Pretend everything in this game's thread was written at `at` (UTC), so a period's edges are exact whatever time the test runs at. */
async function writtenAt(gameId: number, at: string) {
  await getDb().prepare("UPDATE player_messages SET created_at = ? WHERE thread_id = (SELECT id FROM player_message_threads WHERE context_kind = 'game' AND context_id = ?)").run(at, gameId);
  await getDb().prepare("UPDATE player_message_threads SET last_message_at = ? WHERE context_kind = 'game' AND context_id = ?").run(at, gameId);
}
const utc = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}Z`);

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

afterEach(() => {
  delete process.env.MESSAGE_DIGEST_HOURS;
});

describe("the digest", () => {
  it("tells a person once, at the end of the period the messages arrived in, with the count and never the text, and never twice", async () => {
    const host = await adult();
    const player = await adult();
    const g = await game(host, [player]);
    const secret = "the-secret-word-cardamom";
    await sendMessage(player.id, "game", g.id, `first ${secret}`);
    await sendMessage(player.id, "game", g.id, `second ${secret}`);
    await writtenAt(g.id, "2026-06-10 07:30:00");
    // Nothing at the moment of writing, and nothing while the 06:00 to 12:00 period is still running.
    expect(await notices(host.email)).toHaveLength(0);
    expect(await sendDueDigests({ now: utc("2026-06-10 11:59:00"), force: true })).toBe(0);
    // Once it is over: one email for both messages.
    expect(await sendDueDigests({ now: utc("2026-06-10 12:00:01"), force: true })).toBeGreaterThanOrEqual(1);
    const first = await notices(host.email);
    expect(first).toHaveLength(1);
    expect(first[0].body).toContain("2 new messages");
    expect(first[0].body).toContain(`/messages?open=game:${g.id}`);
    expect(first[0].body + first[0].subject + first[0].params).not.toContain(secret);
    expect(first[0].channel).toBe("email");
    expect(await notices(player.email)).toHaveLength(0);
    // The same messages are never told twice, however often it runs.
    expect(await sendDueDigests({ now: utc("2026-06-10 13:00:00"), force: true })).toBe(0);
    expect(await sendDueDigests({ now: utc("2026-06-11 13:00:00"), force: true })).toBe(0);
    expect(await notices(host.email)).toHaveLength(1);
    // A message in the next period is a digest of its own, with its own count.
    await sendMessage(player.id, "game", g.id, "later");
    await getDb().prepare("UPDATE player_messages SET created_at = '2026-06-10 12:30:00' WHERE body = 'later'").run();
    await getDb().prepare("UPDATE player_message_threads SET last_message_at = '2026-06-10 12:30:00' WHERE context_kind = 'game' AND context_id = ?").run(g.id);
    expect(await sendDueDigests({ now: utc("2026-06-10 17:59:00"), force: true })).toBe(0);
    expect(await sendDueDigests({ now: utc("2026-06-10 18:00:01"), force: true })).toBeGreaterThanOrEqual(1);
    const second = await notices(host.email);
    expect(second).toHaveLength(2);
    expect(second[1].body).toContain("1 new message");
  });

  it("sends nothing for what has been read, to the writer, to somebody who muted the conversation or turned the emails off", async () => {
    const host = await adult();
    const reader = await adult();
    const muted = await adult();
    const noMail = await adult();
    await saveMessageSettings(noMail.id, { emailNotices: false });
    const g = await game(host, [reader, muted, noMail]);
    await setContextMute(muted.id, "game", g.id, true);
    await sendMessage(host.id, "game", g.id, "hello all");
    await writtenAt(g.id, "2026-06-10 07:30:00");
    // One reader opens the conversation before the period ends.
    await threadView(reader.id, "game", g.id, { markRead: true });
    await sendDueDigests({ now: utc("2026-06-10 12:30:00"), force: true });
    expect(await notices(reader.email)).toHaveLength(0);
    expect(await notices(muted.email)).toHaveLength(0);
    expect(await notices(noMail.email)).toHaveLength(0);
    expect(await notices(host.email)).toHaveLength(0);
  });

  it("follows each person's choice: at once, a digest (the install's period), or daily", async () => {
    const host = await adult("Hosta", "immediate");
    const daily = await adult("Dani", "daily");
    const digest = await adult("Digi");
    const writer = await adult("Wren");
    const g = await game(writer, [host, daily, digest]);
    // At once: an email as the message is written, with no scheduler, and the scheduler does not repeat it.
    await sendMessage(writer.id, "game", g.id, "hello");
    expect(await notices(host.email)).toHaveLength(1);
    expect((await notices(host.email))[0].body).toContain("1 new message");
    expect(await notices(daily.email)).toHaveLength(0);
    expect(await notices(digest.email)).toHaveLength(0);
    await writtenAt(g.id, "2026-06-10 07:30:00");
    // Six hours on: the digest person is told; the daily one waits for the day to end.
    await sendDueDigests({ now: utc("2026-06-10 12:00:01"), force: true });
    expect(await notices(digest.email)).toHaveLength(1);
    expect(await notices(daily.email)).toHaveLength(0);
    expect(await notices(host.email)).toHaveLength(1);
    await sendDueDigests({ now: utc("2026-06-10 23:59:00"), force: true });
    expect(await notices(daily.email)).toHaveLength(0);
    await sendDueDigests({ now: utc("2026-06-11 00:00:01"), force: true });
    expect(await notices(daily.email)).toHaveLength(1);
    expect(await saveMessageSettings(digest.id, { noticeMode: "weekly" })).toMatchObject({ ok: true, settings: { noticeMode: "digest" } });
    expect(await saveMessageSettings(digest.id, { noticeMode: "daily" })).toMatchObject({ ok: true, settings: { noticeMode: "daily", digestHours: 6 } });
  });

  it("uses the install's period (MESSAGE_DIGEST_HOURS), six hours by default, and ignores a value that is not a number of hours", async () => {
    expect(digestHours()).toBe(6);
    process.env.MESSAGE_DIGEST_HOURS = "1";
    expect(digestHours()).toBe(1);
    const host = await adult();
    const writer = await adult();
    const g = await game(writer, [host]);
    await sendMessage(writer.id, "game", g.id, "hello");
    await writtenAt(g.id, "2026-06-10 07:30:00");
    expect(await sendDueDigests({ now: utc("2026-06-10 07:59:00"), force: true })).toBe(0);
    expect(await sendDueDigests({ now: utc("2026-06-10 08:00:01"), force: true })).toBeGreaterThanOrEqual(1);
    expect(await notices(host.email)).toHaveLength(1);
    for (const bad of ["0", "25", "six", "2.5", ""]) {
      process.env.MESSAGE_DIGEST_HOURS = bad;
      expect(digestHours(), bad).toBe(6);
    }
  });

  it("is told once however many schedulers run at the same moment", async () => {
    const host = await adult();
    const writer = await adult();
    const g = await game(writer, [host]);
    await sendMessage(writer.id, "game", g.id, "hello");
    await writtenAt(g.id, "2026-06-10 07:30:00");
    const now = utc("2026-06-10 12:30:00");
    await Promise.all([sendDueDigests({ now, force: true }), sendDueDigests({ now, force: true }), sendDueDigests({ now, force: true })]);
    expect(await notices(host.email)).toHaveLength(1);
    const claims = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_notices WHERE user_id = ?").get(host.id)) as { n: number };
    expect(claims.n).toBe(1);
  });

  it("is part of the outbox tick, so the scheduler sends it", async () => {
    const host = await adult();
    const writer = await adult();
    const g = await game(writer, [host]);
    await sendMessage(writer.id, "game", g.id, "hello");
    await writtenAt(g.id, "2026-06-10 07:30:00");
    // The tick calls it; with the clock where it is (months later) the messages' period is long over.
    await getDb().prepare("UPDATE player_message_threads SET last_message_at = datetime('now', '-8 hours') WHERE context_kind = 'game' AND context_id = ?").run(g.id);
    await getDb().prepare("UPDATE player_messages SET created_at = datetime('now', '-8 hours') WHERE thread_id = (SELECT id FROM player_message_threads WHERE context_kind = 'game' AND context_id = ?)").run(g.id);
    await tickOutbox();
    expect(await notices(host.email)).toHaveLength(1);
  });
});

describe("a minor's notices", () => {
  /** A group of three who can read it (the organiser, an adult let in and a child) with its conversation begun. */
  async function youth() {
    const org = await adult("Orla");
    const other = await adult("Olly");
    const grp = await createGroup(org.id, { name: `Juniors ${n}`, sport });
    if (!grp.ok) throw new Error(grp.error);
    const g = grp.group.id;
    await markYouthGroup(org.id, g);
    const join = async (u: User) => {
      await joinGroup(u.id, g);
      const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(g, u.id)) as { id: number };
      await decideMember(org.id, row.id, "accept");
    };
    await join(other);
    await setYouthAdult(org.id, g, { memberUserId: other.id, role: "adult", declaredRole: "coach" });
    const guardian = await adult("Gia");
    const made = await addManaged(guardian.id, { displayName: "Aina Lee", birthYear: 2014, relationship: "parent", authority: true }, guardian.name);
    if (!made.ok) throw new Error(made.error);
    const code = await createInvite(guardian, made.person.id, "link");
    if (!code.ok) throw new Error(code.error);
    n++;
    const reg = await registerUser({ name: "Aina Lee", email: `dk${n}@digest.test`, phone: `01381${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!reg.ok) throw new Error(reg.error);
    await saveProfile(reg.user.id, { adult: false });
    await acceptInvite(reg.user, { code: code.code });
    await join(reg.user);
    await setMinorOptIn(reg.user.id, g, true);
    await setConsent(guardian.id, made.person.id, g, true);
    return { org, other, g, kid: reg.user, guardian, pid: made.person.id };
  }
  const stamp = async (g: number, at: string) => {
    await getDb().prepare("UPDATE player_messages SET created_at = ? WHERE thread_id = (SELECT id FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?)").run(at, g);
    await getDb().prepare("UPDATE player_message_threads SET last_message_at = ? WHERE context_kind = 'group' AND context_id = ?").run(at, g);
  };

  it("are governed by the guardian's choice, whatever the child chose, and carry the count only", async () => {
    const { org, g, kid, guardian, pid } = await youth();
    await sendMessage(org.id, "group", g, "Welcome to the Sunday group");
    await stamp(g, "2026-06-10 07:30:00");
    // The default is the digest, as for an adult.
    await sendDueDigests({ now: utc("2026-06-10 12:30:00"), force: true });
    const told = await notices(kid.email);
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("1 new message");
    expect(told[0].body).not.toContain("Welcome to the Sunday group");
    // The guardian turns the notices off: nothing, for new messages.
    expect(await setGuardianNoticeMode(guardian.id, pid, "off")).toMatchObject({ ok: true });
    await sendMessage(org.id, "group", g, "Practice is at nine");
    await getDb().prepare("UPDATE player_messages SET created_at = '2026-06-11 07:30:00' WHERE body = 'Practice is at nine'").run();
    await getDb().prepare("UPDATE player_message_threads SET last_message_at = '2026-06-11 07:30:00' WHERE context_kind = 'group' AND context_id = ?").run(g);
    await sendDueDigests({ now: utc("2026-06-11 12:30:00"), force: true });
    expect(await notices(kid.email)).toHaveLength(1);
    // At once, then: the child is emailed as the message is written.
    expect(await setGuardianNoticeMode(guardian.id, pid, "immediate")).toMatchObject({ ok: true });
    await sendMessage(org.id, "group", g, "Bring a hat");
    expect(await notices(kid.email)).toHaveLength(2);
    // The child has no setting of their own to change it with: nothing of theirs reaches the setting.
    expect(await saveMessageSettings(kid.id, { noticeMode: "immediate" })).toMatchObject({ ok: true, settings: { enabled: false, youth: true } });
    await setGuardianNoticeMode(guardian.id, pid, "off");
    await sendMessage(org.id, "group", g, "One more");
    expect(await notices(kid.email)).toHaveLength(2);
  });
});
