import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { eraseParticipant } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { listVenues, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setPlayerGender } from "../src/lib/who";
import { enter, enterAs, myEntry, tournamentDetail, createTournament, withdraw, type TournamentInput } from "../src/lib/tournaments";
import {
  acceptInvitation,
  addOwnChild,
  archiveTeam,
  createInviteLink,
  createTeam,
  inviteByEmail,
  leaveTeam,
  myTeams,
  previewInvitation,
  removeMember,
  restoreTeam,
  setMemberDetails,
  teamHistory,
  teamHousekeeping,
  teamView,
  transferCaptain,
  updateTeam,
  withdrawInvitation,
  MAX_TEAMS_PER_CAPTAIN,
  type Team,
} from "../src/lib/teams";
import * as teamsRoute from "../src/app/api/teams/route";
import * as teamRoute from "../src/app/api/teams/[id]/route";
import * as invitationRoute from "../src/app/api/team-invitations/route";

/**
 * Teams that persist across events (lib/teams.ts; migration 0269): a team's life, guardians and children, entering
 * events as a team with the roster picked from its members and checked per member, the typed roster as it was, and
 * what privacy asks (export, erasure, retention).
 */

let ownerId: number;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 5;
const today = todayISO();

async function adult(opts: { name?: string; gender?: "woman" | "man"; adult?: boolean | null } = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `${opts.name ?? "Player"} ${n}`, email: `tm${n}@teams.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  if (opts.adult !== null) await saveProfile(made.user.id, { adult: opts.adult ?? true });
  if (opts.gender) await setPlayerGender(made.user.id, opts.gender);
  return made.user;
}

async function child(parent: User, displayName: string, birthYear?: number): Promise<number> {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true, ...(birthYear ? { birthYear } : {}) }, parent.name);
  if (!made.ok) throw new Error(made.error);
  return made.person.id;
}

async function team(captain: User, over: { name?: string; sport?: string; published?: boolean } = {}): Promise<Team> {
  n++;
  const made = await createTeam(captain.id, { name: `Shuttle Club ${n}`, sport: "badminton", ...over });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** The token in the email or the link: the only place it is ever shown. */
const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

/** The link an invitation email carried (the queued message's variables). */
async function emailedLink(to: string): Promise<string> {
  const row = (await getDb().prepare("SELECT params FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 1").get(to)) as { params: string };
  return (JSON.parse(row.params) as { link: string }).link;
}

/** `who` joins the team by a link its captain made: the ordinary way in for a test. */
async function joinTeam(t: Team, captain: User, who: User, input: { participantId?: number; birthDate?: string; gender?: string } = {}) {
  const link = await createInviteLink(captain.id, t.id);
  if (!link.ok) throw new Error(link.error);
  const done = await acceptInvitation(who, tokenOf(link.value.link), input);
  if (!done.ok) throw new Error(done.error);
  return done.value;
}

const memberId = async (t: Team, viewer: User, name: string) => (await teamView(t.id, viewer.id))!.roster!.find((m) => m.name === name)!.id;
const mail = async (to: string) =>
  (await getDb().prepare("SELECT subject, body FROM messages WHERE kind = 'programme' AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];

async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(today, dayOffset++);
  const made = await createTournament(
    { venueId, name: `Team Cup ${dayOffset}`, sport: "badminton", format: "knockout", teamSize: 1, entryKind: "team", roster: { min: 2, max: 4 }, level: null, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: courts, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const born = (years: number, onDay: string) => `${Number(onDay.slice(0, 4)) - years - 1}-06-15`;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("a team's life", () => {
  it("is started by a declared adult, who is its captain and first member", async () => {
    const unsaid = await adult({ adult: null });
    expect(await createTeam(unsaid.id, { name: "Nobody FC", sport: "badminton" })).toMatchObject({ ok: false, code: "TM_ADULT_ONLY" });
    const minor = await adult({ adult: false });
    expect(await createTeam(minor.id, { name: "Nobody FC", sport: "badminton" })).toMatchObject({ ok: false, code: "TM_ADULT_ONLY" });
    const cap = await adult();
    expect(await createTeam(cap.id, { name: "ab", sport: "badminton" })).toMatchObject({ ok: false, code: "TM_NAME" });
    expect(await createTeam(cap.id, { name: "Fine Name", sport: "no-such-sport" })).toMatchObject({ ok: false, code: "TM_SPORT" });
    const made = await createTeam(cap.id, { name: "Fine Name", sport: "badminton", description: "Tuesday crowd" });
    if (!made.ok) throw new Error(made.error);
    expect(made.value).toMatchObject({ name: "Fine Name", status: "active", published: false, members: 1, isCaptain: true });
    expect(made.value.roster).toEqual([expect.objectContaining({ role: "captain", mine: true })]);
    expect(await createTeam(cap.id, { name: "fine name", sport: "badminton" })).toMatchObject({ ok: false, code: "TM_NAME_TAKEN" });
    // Its sport and venue are named from the lists; a group only one of the captain's own.
    expect(await createTeam(cap.id, { name: "Elsewhere", sport: "badminton", venueId: 999999 })).toMatchObject({ ok: false, code: "TM_VENUE" });
    expect(await createTeam(cap.id, { name: "Not Mine", sport: "badminton", groupId: 999999 })).toMatchObject({ ok: false, code: "TM_GROUP" });
    expect(await createTeam(cap.id, { name: "At Venue", sport: "badminton", venueId })).toMatchObject({ ok: true });
  });

  it("is limited to a few teams for one captain at a time", async () => {
    const cap = await adult();
    for (let i = 0; i < MAX_TEAMS_PER_CAPTAIN; i++) await team(cap);
    expect(await createTeam(cap.id, { name: "One More", sport: "badminton" })).toMatchObject({ ok: false, code: "TM_TOO_MANY" });
  });

  it("is seen by its members; by anybody else only its name and sport, and only if its captain publishes it", async () => {
    const cap = await adult();
    const t = await team(cap);
    const stranger = await adult();
    expect(await teamView(t.id, stranger.id)).toBeNull();
    expect(await teamView(t.id, null)).toBeNull();
    const upd = await updateTeam(cap.id, t.id, { published: true, description: "Secret plans" });
    expect(upd.ok).toBe(true);
    for (const viewer of [stranger.id, null]) {
      const seen = (await teamView(t.id, viewer))!;
      expect(seen).toMatchObject({ name: t.name, sport: "badminton", published: true });
      expect(seen.roster).toBeUndefined();
      expect(seen.description).toBeNull();
      expect(seen.invitations).toBeUndefined();
      expect(seen.members).toBe(0);
    }
    // Only the captain changes it.
    const m = await adult();
    await joinTeam(t, cap, m);
    expect(await updateTeam(m.id, t.id, { name: "Hijacked" })).toMatchObject({ ok: false, code: "TM_CAPTAIN_ONLY" });
    expect(await updateTeam(stranger.id, t.id, { name: "Hijacked" })).toMatchObject({ ok: false, code: "TM_NOT_FOUND" });
    // Archiving takes it off the public page.
    expect((await archiveTeam(cap.id, t.id)).ok).toBe(true);
    expect(await teamView(t.id, stranger.id)).toBeNull();
  });

  it("is joined by accepting a link the captain shares: once, never by the captain, never after it was withdrawn or ran out", async () => {
    const cap = await adult();
    const t = await team(cap);
    const link = await createInviteLink(cap.id, t.id);
    if (!link.ok) throw new Error(link.error);
    const token = tokenOf(link.value.link);
    expect(link.value.invitations).toHaveLength(1);
    // The captain's own link is not theirs to use.
    expect(await acceptInvitation(cap, token)).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    const first = await adult();
    const preview = await previewInvitation(first, token);
    expect(preview).toMatchObject({ ok: true, value: { team: t.name, sport: "badminton" } });
    expect(await acceptInvitation(first, token, { birthDate: "1990-04-02", gender: "woman" })).toMatchObject({ ok: true, value: { teamId: t.id } });
    const view = (await teamView(t.id, first.id))!;
    expect(view.roster).toHaveLength(2);
    expect(view.mine).toEqual([expect.objectContaining({ role: "member" })]);
    // Used once.
    const second = await adult();
    expect(await acceptInvitation(second, token)).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    expect(await previewInvitation(second, token)).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    // The captain was told, in the reader's language.
    expect((await mail(cap.email)).some((x) => x.subject.includes("joined"))).toBe(true);
    // Withdrawn, and run out: the same refusal.
    const l2 = await createInviteLink(cap.id, t.id);
    if (!l2.ok) throw new Error(l2.error);
    const open = (await teamView(t.id, cap.id))!.invitations!;
    expect((await withdrawInvitation(cap.id, t.id, open[0].id)).ok).toBe(true);
    expect(await acceptInvitation(second, tokenOf(l2.value.link))).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    const l3 = await createInviteLink(cap.id, t.id);
    if (!l3.ok) throw new Error(l3.error);
    await getDb().prepare("UPDATE team_invitations SET expires_at = datetime('now', '-1 hour') WHERE team_id = ?").run(t.id);
    expect(await acceptInvitation(second, tokenOf(l3.value.link))).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    // Only the captain makes or withdraws them.
    expect(await createInviteLink(first.id, t.id)).toMatchObject({ ok: false, code: "TM_CAPTAIN_ONLY" });
  });

  it("is invited by email without the address being looked up: the same answer and the same work whoever holds it", async () => {
    const cap = await adult();
    const t = await team(cap);
    const holder = await adult();
    const before = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'account_email'").get()) as { n: number };
    const known = await inviteByEmail(cap.id, t.id, holder.email);
    const unknown = await inviteByEmail(cap.id, t.id, "nobody-has-this@teams.test");
    expect(known).toMatchObject({ ok: true });
    expect(unknown).toMatchObject({ ok: true });
    if (!known.ok || !unknown.ok) return;
    expect(Object.keys(known.value)).toEqual(Object.keys(unknown.value));
    const after = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'account_email'").get()) as { n: number };
    expect(after.n - before.n).toBe(2);
    expect(await inviteByEmail(cap.id, t.id, "not an address")).toMatchObject({ ok: false, code: "INVITE_EMAIL_INVALID" });
    expect(await inviteByEmail(cap.id, t.id, cap.email)).toMatchObject({ ok: false, code: "INVITE_EMAIL_SELF" });
    // Only the hash of the address and the link are kept.
    const kept = (await getDb().prepare("SELECT token_hash, email_hash FROM team_invitations WHERE team_id = ?").all(t.id)) as { token_hash: string; email_hash: string }[];
    const link = await emailedLink(holder.email);
    expect(kept.some((k) => k.token_hash === tokenOf(link) || k.email_hash.includes("@"))).toBe(false);
    // The account the address belongs to accepts; another account cannot use the link.
    const other = await adult();
    expect(await acceptInvitation(other, tokenOf(link))).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    expect(await acceptInvitation(holder, tokenOf(link))).toMatchObject({ ok: true });
    // Inviting the address again replaces the link.
    const again = await adult();
    await inviteByEmail(cap.id, t.id, again.email);
    const first = await emailedLink(again.email);
    await inviteByEmail(cap.id, t.id, again.email);
    const second = await emailedLink(again.email);
    expect(await acceptInvitation(again, tokenOf(first))).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    expect(await acceptInvitation(again, tokenOf(second))).toMatchObject({ ok: true });
  });

  it("is for declared adults only, never across a block, and invitations count toward the daily limit", async () => {
    const cap = await adult();
    const t = await team(cap);
    const link = await createInviteLink(cap.id, t.id);
    if (!link.ok) throw new Error(link.error);
    const token = tokenOf(link.value.link);
    const minor = await adult({ adult: false });
    const unsaid = await adult({ adult: null });
    for (const who of [minor, unsaid]) {
      expect(await acceptInvitation(who, token)).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
      expect(await previewInvitation(who, token)).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    }
    const blocked = await adult();
    await getDb().prepare("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(blocked.id, cap.id);
    expect(await acceptInvitation(blocked, token)).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    // Thirty invitations a day, to games, groups and teams together.
    const heavy = await adult();
    const ht = await team(heavy);
    for (let i = 0; i < 30; i++) expect((await createInviteLink(heavy.id, ht.id)).ok).toBe(true);
    expect(await createInviteLink(heavy.id, ht.id)).toMatchObject({ ok: false, code: "TM_INVITES_TODAY", status: 429 });
    expect(await inviteByEmail(heavy.id, ht.id, "late@teams.test")).toMatchObject({ ok: false, code: "TM_INVITES_TODAY" });
  });

  it("members leave; the captain takes members off, hands the team on, or archives it (not while it is entered)", async () => {
    const cap = await adult();
    const t = await team(cap);
    const a = await adult({ name: "Aina" });
    const b = await adult({ name: "Bala" });
    await joinTeam(t, cap, a);
    await joinTeam(t, cap, b);
    // The captain cannot just leave.
    expect(await leaveTeam(cap.id, t.id)).toMatchObject({ ok: false, code: "TM_CAPTAIN_LEAVES" });
    // A member leaves, and the captain is told.
    expect((await leaveTeam(a.id, t.id)).ok).toBe(true);
    expect((await teamView(t.id, a.id))).toBeNull();
    expect((await mail(cap.email)).some((x) => x.subject.includes("left"))).toBe(true);
    expect(await leaveTeam(a.id, t.id)).toMatchObject({ ok: false, code: "TM_NOT_MEMBER" });
    // Only the captain takes somebody off; they are told.
    const bid = await memberId(t, cap, "Bala");
    expect(await removeMember(b.id, t.id, bid)).toMatchObject({ ok: false, code: "TM_CAPTAIN_ONLY" });
    expect((await removeMember(cap.id, t.id, bid)).ok).toBe(true);
    expect((await mail(b.email)).some((x) => x.subject.includes("off"))).toBe(true);
    // Handing it on goes to a member with an account who has said they are an adult.
    const c = await adult({ name: "Chong" });
    await joinTeam(t, cap, c);
    const cid = await memberId(t, cap, "Chong");
    expect(await transferCaptain(c.id, t.id, cid)).toMatchObject({ ok: false, code: "TM_CAPTAIN_ONLY" });
    const handed = await transferCaptain(cap.id, t.id, cid);
    expect(handed).toMatchObject({ ok: true });
    expect((await teamView(t.id, c.id))!.isCaptain).toBe(true);
    expect((await teamView(t.id, cap.id))!.isCaptain).toBe(false);
    expect((await teamView(t.id, cap.id))!.roster).toHaveLength(2);
    expect((await mail(c.email)).some((x) => x.subject.includes("captain"))).toBe(true);
    // The old captain is a member now, and may leave.
    expect((await leaveTeam(cap.id, t.id)).ok).toBe(true);
    // Archived, it cannot be archived while entered in an event to come; brought back, it counts again.
    const tour = await tournament();
    const roster = [(await teamView(t.id, c.id))!.roster![0].id];
    const d1 = await adult({ name: "Dev" });
    await joinTeam(t, c, d1);
    const both = (await teamView(t.id, c.id))!.roster!.map((m) => m.id);
    expect(roster.length).toBe(1);
    expect(await enter(c, tour.id, { teamId: t.id, rosterMemberIds: both })).toMatchObject({ ok: true });
    expect(await archiveTeam(c.id, t.id)).toMatchObject({ ok: false, code: "TM_ARCHIVE_ENTERED" });
    const mine = (await myEntry(c.id, tour.id))!;
    await withdraw(mine.id);
    expect((await archiveTeam(c.id, t.id)).ok).toBe(true);
    expect(await updateTeam(c.id, t.id, { name: "Renamed" })).toMatchObject({ ok: false, code: "TM_ARCHIVED" });
    expect(await createInviteLink(c.id, t.id)).toMatchObject({ ok: false, code: "TM_ARCHIVED" });
    expect((await restoreTeam(c.id, t.id)).ok).toBe(true);
    expect((await myTeams(c.id)).map((x) => x.id)).toContain(t.id);
  });
});

describe("children", () => {
  it("are put on a team by their guardian only: the captain's own child directly, anybody else's through that guardian accepting", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const mine = await child(cap, "Mia");
    const added = await addOwnChild(cap.id, t.id, mine, { birthDate: "2014-03-01", gender: "woman" });
    expect(added).toMatchObject({ ok: true });
    // The record: a participant, acted for by the captain, whose agreement is recorded; never an account.
    const row = (await getDb().prepare("SELECT user_id, participant_id, acting_user_id, agreed_at FROM team_members WHERE participant_id = ?").get(mine)) as {
      user_id: number | null;
      participant_id: number;
      acting_user_id: number;
      agreed_at: string | null;
    };
    expect(row).toMatchObject({ user_id: null, participant_id: mine, acting_user_id: cap.id });
    expect(row.agreed_at).not.toBeNull();
    expect(await addOwnChild(cap.id, t.id, mine)).toMatchObject({ ok: false, code: "TM_ALREADY" });
    // Somebody else's child cannot be added by the captain.
    const other = await adult({ name: "Parent" });
    const theirs = await child(other, "Noor");
    expect(await addOwnChild(cap.id, t.id, theirs)).toMatchObject({ ok: false, code: "TM_NOT_YOURS" });
    // Through the guardian: they accept the invitation for the child, not for themself.
    const link = await createInviteLink(cap.id, t.id);
    if (!link.ok) throw new Error(link.error);
    const token = tokenOf(link.value.link);
    expect(await previewInvitation(other, token)).toMatchObject({ ok: true, value: { canActFor: [{ participantId: theirs, name: "Noor" }] } });
    // Not for a child somebody else manages.
    expect(await acceptInvitation(other, token, { participantId: mine })).toMatchObject({ ok: false, code: "TM_NOT_YOURS" });
    expect(await acceptInvitation(other, token, { participantId: theirs })).toMatchObject({ ok: true });
    const seen = (await teamView(t.id, other.id))!;
    // The guardian is not on the team themself; the child is, through them.
    expect(seen.mine).toEqual([expect.objectContaining({ participantId: theirs })]);
    expect(seen.roster!.filter((m) => m.mine).map((m) => m.name)).toEqual(["Noor"]);
    // The captain is told, naming the child.
    expect((await mail(cap.email)).some((x) => x.body.includes("Noor"))).toBe(true);
  });

  it("are named only to the captain and their own guardian: other members and everybody else see a junior player", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap, { published: true });
    const parent = await adult({ name: "Parent" });
    const kid = await child(parent, "Sofea");
    await joinTeam(t, cap, parent, { participantId: kid });
    const friend = await adult({ name: "Friend" });
    await joinTeam(t, cap, friend);
    const named = (viewer: User) => (async () => (await teamView(t.id, viewer.id))!.roster!.map((m) => m.name))();
    expect(await named(cap)).toContain("Sofea");
    expect(await named(parent)).toContain("Sofea");
    const asFriend = await named(friend);
    expect(asFriend).not.toContain("Sofea");
    expect(asFriend).toContain(null);
    expect((await teamView(t.id, friend.id))!.roster!.find((m) => m.junior)).toMatchObject({ junior: true, name: null });
    // The public sees no roster at all.
    expect((await teamView(t.id, null))!.roster).toBeUndefined();
    // The guardian may take the child off, for them.
    expect((await leaveTeam(parent.id, t.id, kid)).ok).toBe(true);
    expect(await named(cap)).not.toContain("Sofea");
  });

  it("never join by their own account: an account that says it is under 18 cannot accept, and a child is not a user", async () => {
    const cap = await adult();
    const t = await team(cap);
    const link = await createInviteLink(cap.id, t.id);
    if (!link.ok) throw new Error(link.error);
    const teen = await adult({ adult: false });
    expect(await acceptInvitation(teen, tokenOf(link.value.link))).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
    const rows = (await getDb().prepare("SELECT user_id, participant_id FROM team_members WHERE team_id = ?").all(t.id)) as { user_id: number | null; participant_id: number | null }[];
    expect(rows.every((r) => (r.user_id === null) !== (r.participant_id === null))).toBe(true);
    // The guardian of a child must themself be a declared adult to put them on a team.
    const parent = await adult({ adult: null });
    const kid = await child(parent, "Zack");
    expect(await acceptInvitation(parent, tokenOf(link.value.link), { participantId: kid })).toMatchObject({ ok: false, code: "TM_INVITE_INVALID" });
  });

  it("are declared for events by their guardian, as their word", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const kid = await child(cap, "Lina");
    await addOwnChild(cap.id, t.id, kid);
    const view = (await teamView(t.id, cap.id))!;
    const lina = view.roster!.find((m) => m.junior)!;
    expect(lina.birthDeclared).toBe(false);
    expect((await setMemberDetails(cap.id, lina.id, { birthDate: "2015-01-02", gender: "woman" })).ok).toBe(true);
    expect(((await teamView(t.id, cap.id))!.roster!.find((m) => m.junior)!).birthDeclared).toBe(true);
    expect(await setMemberDetails(cap.id, lina.id, { birthDate: "next year" })).toMatchObject({ ok: false, code: "TM_BIRTH" });
    expect(await setMemberDetails(cap.id, lina.id, { gender: "robot" })).toMatchObject({ ok: false, code: "TM_GENDER" });
    // Not by anybody else on the team.
    const m = await adult();
    await joinTeam(t, cap, m);
    expect(await setMemberDetails(m.id, lina.id, { birthDate: "2001-01-01" })).toMatchObject({ ok: false, code: "TM_NOT_MEMBER" });
  });
});

describe("entering events as a team", () => {
  it("names the team and picks the roster from its members; the typed roster and team name still work for anybody", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const a = await adult({ name: "Aina" });
    const b = await adult({ name: "Bala" });
    await joinTeam(t, cap, a);
    await joinTeam(t, cap, b);
    const view = (await teamView(t.id, cap.id))!;
    const ids = view.roster!.map((m) => m.id);
    const tour = await tournament();
    // Roster size, and only the team's own members.
    expect(await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids.slice(0, 1) })).toMatchObject({ ok: false, code: "TM_ROSTER_SIZE" });
    expect(await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: [...ids.slice(0, 2), 999999] })).toMatchObject({ ok: false, code: "TM_PICK_NOT_ON" });
    // Only the captain, only an active team of the event's sport.
    expect(await enter(a, tour.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: false, code: "TM_ENTRY_CAPTAIN" });
    const squash = await createTeam(cap.id, { name: "Squash Side", sport: "squash" });
    if (!squash.ok) throw new Error(squash.error);
    expect(await enter(cap, tour.id, { teamId: squash.value.id, rosterMemberIds: ids })).toMatchObject({ ok: false, code: "TM_ENTRY_SPORT" });
    const done = await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids });
    if (!done.ok) throw new Error(done.error);
    expect(done.value).toMatchObject({ name: t.name });
    expect(done.value.roster).toHaveLength(3);
    const rows = (await getDb().prepare("SELECT team_id FROM tournament_entries WHERE id = ?").get(done.value.id)) as { team_id: number };
    expect(rows.team_id).toBe(t.id);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM tournament_entry_members WHERE entry_id = ?").get(done.value.id)) as { n: number }).n).toBe(3);
    // The public sees the team's name, never the roster.
    expect((await tournamentDetail(tour.id))!.entries[0].roster).toBeUndefined();
    // Each member is told (the captain too).
    expect((await mail(a.email)).some((x) => x.subject.includes(tour.name))).toBe(true);
    // The same team twice, or a member on two rosters, is refused.
    expect(await enter(await adult(), tour.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: false });
    const t2 = await team(await adult({ name: "Other" }));
    const other = (await teamView(t2.id, (await getDb().prepare("SELECT captain_user_id AS id FROM teams WHERE id = ?").get(t2.id) as { id: number }).id))!;
    expect(other.members).toBe(1);
    // A typed team beside it, exactly as before.
    const typed = await enter(await adult(), tour.id, { teamName: "Typed Team", roster: ["Ali Bin", "Bala Raj", "Chong Wei"] });
    expect(typed).toMatchObject({ ok: true, value: { name: "Typed Team", roster: ["Ali Bin", "Bala Raj", "Chong Wei"] } });
    expect(((await getDb().prepare("SELECT team_id FROM tournament_entries WHERE id = ?").get(typed.ok ? typed.value.id : 0)) as { team_id: number | null }).team_id).toBeNull();
    expect(await enter(await adult(), tour.id, { teamName: "typed team", roster: ["X One", "Y Two"] })).toMatchObject({ ok: false, error: "A team of that name has entered already." });
    // Only a team event takes a team; a counter or a guardian's entry names none.
    const single = await tournament({ entryKind: "player", roster: null });
    expect(await enter(cap, single.id, { teamId: squash.value.id })).toMatchObject({ ok: false, code: "TM_ENTRY_NOT_TEAM" });
    expect(await enterAs({ kind: "counter", adminId: ownerId, adminName: "Staff", phone: "0123456789", name: "X", participantId: null }, tour.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({
      ok: false,
      code: "TM_ENTRY_SELF_ONLY",
    });
  });

  it("holds each member to the event's age range by their own declared date of birth, not the captain's word", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const a = await adult({ name: "Aina" });
    const b = await adult({ name: "Bala" });
    await joinTeam(t, cap, a, { birthDate: "1990-01-01" });
    await joinTeam(t, cap, b);
    const tour = await tournament({ ageMin: 18, ageMax: 40 });
    const ids = (await teamView(t.id, cap.id))!.roster!.map((m) => m.id);
    // Two have not said a date of birth.
    expect(await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: false, code: "TM_MEMBER_BIRTH" });
    await setMemberDetails(cap.id, ids[0], { birthDate: "1995-05-05" });
    await setMemberDetails(b.id, ids[2], { birthDate: "1950-05-05" });
    expect(await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: false, code: "TM_MEMBER_AGE", vars: expect.objectContaining({ name: expect.stringContaining("Bala") }) });
    await setMemberDetails(b.id, ids[2], { birthDate: "1995-05-05" });
    const ok = await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids });
    expect(ok).toMatchObject({ ok: true });
    // No document asked for, no verification claimed: it is the roster as declared, and the captain declared nothing about ages.
    expect((await getDb().prepare("SELECT guardian_name, birth_date FROM tournament_entries WHERE id = ?").get(ok.ok ? ok.value.id : 0)) as object).toEqual({ guardian_name: null, birth_date: null });
  });

  it("takes a child on the roster of a junior event through their guardian's recorded agreement; an account that says it is under 18 on the day is refused", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const kid = await child(cap, "Mia");
    await addOwnChild(cap.id, t.id, kid, { birthDate: born(12, addDays(today, dayOffset)) });
    const grown = await adult({ name: "Grown" });
    await joinTeam(t, cap, grown, { birthDate: born(14, addDays(today, dayOffset)) });
    const ids = (await teamView(t.id, cap.id))!.roster!.filter((m) => !m.mine || m.junior).map((m) => m.id);
    const juniors = await tournament({ ageMin: 8, ageMax: 15 });
    // A young person on their own account is refused: only through a guardian.
    expect(await enter(cap, juniors.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: false });
    const kidOnly = (await teamView(t.id, cap.id))!.roster!.filter((m) => m.junior).map((m) => m.id);
    const capId = (await teamView(t.id, cap.id))!.roster!.find((m) => m.role === "captain")!.id;
    // The captain is an adult, so cannot be on a junior roster either.
    expect(await enter(cap, juniors.id, { teamId: t.id, rosterMemberIds: [...kidOnly, capId] })).toMatchObject({ ok: false, code: "TM_MEMBER_BIRTH" });
    await setMemberDetails(cap.id, capId, { birthDate: "1980-01-01" });
    expect(await enter(cap, juniors.id, { teamId: t.id, rosterMemberIds: [...kidOnly, capId] })).toMatchObject({ ok: false, code: "TM_MEMBER_AGE" });
    // The child alone and one more junior: the one more is a participant again.
    const kid2 = await child(cap, "Noah");
    await addOwnChild(cap.id, t.id, kid2, { birthDate: born(10, addDays(today, dayOffset)) });
    const two = (await teamView(t.id, cap.id))!.roster!.filter((m) => m.junior).map((m) => m.id);
    const entered = await enter(cap, juniors.id, { teamId: t.id, rosterMemberIds: two });
    expect(entered).toMatchObject({ ok: true });
    // Recorded as declared: that they were under 18 and the guardian agreed when they joined; never verified.
    const rows = (await getDb().prepare("SELECT declared_minor, guardian_agreed_at FROM tournament_entry_members WHERE entry_id = ?").all(entered.ok ? entered.value.id : 0)) as {
      declared_minor: boolean;
      guardian_agreed_at: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.declared_minor === true && r.guardian_agreed_at !== null)).toBe(true);
    // The guardian is told about the child, naming them.
    const told = await mail(cap.email);
    expect(told.some((m) => m.body.includes("Mia") && m.subject.includes(juniors.name))).toBe(true);
  });

  it("checks a women's or men's event by what each member said, and a members-only event by each member's own membership", async () => {
    const cap = await adult({ name: "Captain", gender: "woman" });
    const t = await team(cap);
    const a = await adult({ name: "Aina", gender: "woman" });
    const man = await adult({ name: "Raj", gender: "man" });
    const unsaid = await adult({ name: "Quiet" });
    await joinTeam(t, cap, a);
    await joinTeam(t, cap, man);
    await joinTeam(t, cap, unsaid);
    const view = (await teamView(t.id, cap.id))!;
    const idOf = (name: string) => view.roster!.find((m) => m.name === name.split(" ")[0] || m.name === name)!.id;
    const women = await tournament({ category: "women" });
    const ids = [idOf(cap.name), idOf(a.name)];
    expect(await enter(cap, women.id, { teamId: t.id, rosterMemberIds: [...ids, idOf(man.name)] })).toMatchObject({ ok: false, code: "TM_MEMBER_WOMEN" });
    expect(await enter(cap, women.id, { teamId: t.id, rosterMemberIds: [...ids, idOf(unsaid.name)] })).toMatchObject({ ok: false, code: "TM_MEMBER_GENDER" });
    expect(await enter(cap, women.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: true });
    // A child's gender is the guardian's declaration.
    const mt = await team(cap);
    const kid = await child(cap, "Mei");
    await addOwnChild(cap.id, mt.id, kid);
    const mixed = (await teamView(mt.id, cap.id))!.roster!;
    const women2 = await tournament({ category: "women" });
    const kidId = mixed.find((m) => m.junior)!.id;
    const capId = mixed.find((m) => m.role === "captain")!.id;
    expect(await enter(cap, women2.id, { teamId: mt.id, rosterMemberIds: [kidId, capId] })).toMatchObject({ ok: false, code: "TM_MEMBER_GENDER" });
    await setMemberDetails(cap.id, kidId, { gender: "woman" });
    expect(await enter(cap, women2.id, { teamId: mt.id, rosterMemberIds: [kidId, capId] })).toMatchObject({ ok: true });
    // Members only: each member's own membership.
    const club = await tournament({ membersOnly: true });
    const st = await team(cap);
    const m1 = await adult({ name: "Mem" });
    await joinTeam(st, cap, m1);
    const sv = (await teamView(st.id, cap.id))!.roster!.map((m) => m.id);
    expect(await enter(cap, club.id, { teamId: st.id, rosterMemberIds: sv })).toMatchObject({ ok: false, code: "TM_MEMBER_MEMBERS_ONLY" });
    for (const u of [cap, m1])
      await sellMembership({ venueId, holderName: u.name, holderPhone: u.phone, startsOn: today, expiresOn: addDays(today, 90), price: 50, adminId: ownerId, userId: u.id });
    expect(await enter(cap, club.id, { teamId: st.id, rosterMemberIds: sv })).toMatchObject({ ok: true });
  });

  it("refuses somebody already on another team's roster in the same event", async () => {
    const tour = await tournament();
    const shared = await adult({ name: "Shared" });
    const c1 = await adult({ name: "One" });
    const c2 = await adult({ name: "Two" });
    const t1 = await team(c1);
    const t2 = await team(c2);
    await joinTeam(t1, c1, shared);
    await joinTeam(t2, c2, shared);
    expect(await enter(c1, tour.id, { teamId: t1.id, rosterMemberIds: (await teamView(t1.id, c1.id))!.roster!.map((m) => m.id) })).toMatchObject({ ok: true });
    expect(await enter(c2, tour.id, { teamId: t2.id, rosterMemberIds: (await teamView(t2.id, c2.id))!.roster!.map((m) => m.id) })).toMatchObject({
      ok: false,
      code: "TM_MEMBER_ENTERED",
    });
  });

  it("takes a member who leaves off the rosters of events not yet drawn and tells the captain when it is now short", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const a = await adult({ name: "Aina" });
    await joinTeam(t, cap, a);
    const tour = await tournament();
    const ids = (await teamView(t.id, cap.id))!.roster!.map((m) => m.id);
    const entry = await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids });
    if (!entry.ok) throw new Error(entry.error);
    expect((await leaveTeam(a.id, t.id)).ok).toBe(true);
    const after = (await getDb().prepare("SELECT roster FROM tournament_entries WHERE id = ?").get(entry.value.id)) as { roster: string };
    expect(JSON.parse(after.roster)).toHaveLength(1);
    expect((await mail(cap.email)).some((x) => x.subject.includes("too short"))).toBe(true);
  });

  it("is readable by its members in its history: what it entered and each result", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const a = await adult({ name: "Aina" });
    await joinTeam(t, cap, a);
    const tour = await tournament();
    const ids = (await teamView(t.id, cap.id))!.roster!.map((m) => m.id);
    expect(await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids })).toMatchObject({ ok: true });
    const hist = await teamHistory(a.id, t.id);
    expect(hist).toMatchObject({ ok: true, value: { tournaments: [expect.objectContaining({ tournament: tour.name, entryStatus: "entered" })], leagues: [] } });
    // Not for anybody else.
    expect(await teamHistory((await adult()).id, t.id)).toMatchObject({ ok: false, code: "TM_NOT_FOUND" });
  });
});

describe("privacy", () => {
  it("puts teams in the export: its place on each, and the children it acts for; nothing about others", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const parent = await adult({ name: "Parent" });
    const kid = await child(parent, "Sara");
    await joinTeam(t, cap, parent, { participantId: kid, birthDate: "2014-02-02" });
    const friend = await adult({ name: "Friend" });
    await joinTeam(t, cap, friend, { birthDate: "1991-01-01" });
    const exported = (await exportCustomerData(parent.id))!;
    expect(exported.teams).toEqual([expect.objectContaining({ team: t.name, on_behalf_of: "Sara", declared_birth_date: "2014-02-02", guardian_agreed_at: expect.any(String) })]);
    expect(JSON.stringify(exported.teams)).not.toContain("Friend");
    const mine = (await exportCustomerData(friend.id))!;
    expect(mine.teams).toEqual([expect.objectContaining({ team: t.name, role: "member", declared_birth_date: "1991-01-01", on_behalf_of: null })]);
  });

  it("hands the captaincy to the longest-standing adult member when the captain's account is erased, and archives a team nobody can lead", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const a = await adult({ name: "Aina" });
    const b = await adult({ name: "Bala" });
    await joinTeam(t, cap, a);
    await joinTeam(t, cap, b);
    const tour = await tournament();
    const ids = (await teamView(t.id, cap.id))!.roster!.map((m) => m.id);
    const entry = await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids });
    if (!entry.ok) throw new Error(entry.error);
    expect(await eraseCustomer(cap.id)).toMatchObject({ ok: true });
    const view = (await teamView(t.id, a.id))!;
    expect(view.isCaptain).toBe(true);
    expect(view.roster!.map((m) => m.name).sort()).toEqual(["Aina", "Bala"]);
    expect(view.members).toBe(2);
    // What they played stays in the event's record, their name anonymised.
    const names = (await getDb().prepare("SELECT name FROM tournament_entry_members WHERE entry_id = ?").all(entry.value.id)) as { name: string }[];
    expect(names.map((x) => x.name)).toContain("(removed)");
    expect(JSON.parse(((await getDb().prepare("SELECT roster FROM tournament_entries WHERE id = ?").get(entry.value.id)) as { roster: string }).roster)).toContain("(removed)");
    // A team whose only adult member is erased has nobody to lead it: archived, and withdrawn from events.
    const solo = await adult({ name: "Solo" });
    const st = await team(solo);
    const kid = await child(solo, "Tiny");
    await addOwnChild(solo.id, st.id, kid);
    const tour2 = await tournament({ roster: { min: 1, max: 4 } });
    const ents = (await teamView(st.id, solo.id))!.roster!.map((m) => m.id);
    const entered = await enter(solo, tour2.id, { teamId: st.id, rosterMemberIds: ents });
    if (!entered.ok) throw new Error(entered.error);
    expect(await eraseCustomer(solo.id)).toMatchObject({ ok: true });
    const gone = (await getDb().prepare("SELECT status, captain_user_id FROM teams WHERE id = ?").get(st.id)) as { status: string; captain_user_id: number | null };
    expect(gone).toEqual({ status: "archived", captain_user_id: null });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM team_members WHERE team_id = ?").get(st.id)) as { n: number }).n).toBe(0);
    expect(((await getDb().prepare("SELECT status FROM tournament_entries WHERE id = ?").get(entered.value.id)) as { status: string }).status).toBe("withdrawn");
  });

  it("takes a child off every team when their record is erased, their name anonymised on rosters kept", async () => {
    const cap = await adult({ name: "Captain" });
    const t = await team(cap);
    const kid = await child(cap, "Dina");
    await addOwnChild(cap.id, t.id, kid);
    const tour = await tournament({ roster: { min: 1, max: 4 } });
    const ids = (await teamView(t.id, cap.id))!.roster!.map((m) => m.id);
    const entry = await enter(cap, tour.id, { teamId: t.id, rosterMemberIds: ids });
    if (!entry.ok) throw new Error(entry.error);
    await eraseParticipant(kid, "Test");
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM team_members WHERE participant_id IS NOT NULL AND team_id = ?").get(t.id)) as { n: number }).n).toBe(0);
    expect((await getDb().prepare("SELECT name FROM tournament_entry_members WHERE entry_id = ? AND name = 'Dina'").all(entry.value.id)).length).toBe(0);
  });

  it("forgets members who left a year ago and invitations long past their time", async () => {
    const cap = await adult();
    const t = await team(cap);
    const a = await adult();
    await joinTeam(t, cap, a);
    await leaveTeam(a.id, t.id);
    const b = await adult();
    await joinTeam(t, cap, b);
    await leaveTeam(b.id, t.id);
    await getDb().prepare("UPDATE team_members SET left_at = datetime('now', '-400 days') WHERE user_id = ?").run(a.id);
    await createInviteLink(cap.id, t.id);
    await getDb().prepare("UPDATE team_invitations SET expires_at = datetime('now', '-10 days') WHERE team_id = ?").run(t.id);
    const done = await teamHousekeeping();
    expect(done.members).toBeGreaterThanOrEqual(1);
    expect(done.invitations).toBeGreaterThanOrEqual(1);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM team_members WHERE user_id = ?").get(a.id)) as { n: number }).n).toBe(0);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM team_members WHERE user_id = ?").get(b.id)) as { n: number }).n).toBe(1);
  });
});

describe("the routes", () => {
  const as = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;
  const call = (handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, url: string, method: string, body: unknown, cookie?: string, params: Record<string, string> = {}) =>
    handler(new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), {
      params: Promise.resolve(params),
    });

  it("create, show, invite and accept, with refusals carrying their codes", async () => {
    const cap = await adult();
    const cookie = await as(cap);
    expect((await call(teamsRoute.POST as never, "/api/teams", "POST", { name: "Route Team", sport: "badminton" })).status).toBe(401);
    const made = await call(teamsRoute.POST as never, "/api/teams", "POST", { name: "Route Team", sport: "badminton" }, cookie);
    expect(made.status).toBe(201);
    const team = ((await made.json()) as { team: Team }).team;
    const bad = await call(teamsRoute.POST as never, "/api/teams", "POST", { name: "x", sport: "badminton" }, cookie);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "TM_NAME", error: expect.any(String) });
    // Not found to a stranger until it is published.
    const stranger = await adult();
    expect((await call(teamRoute.GET as never, `/api/teams/${team.id}`, "GET", undefined, await as(stranger), { id: String(team.id) })).status).toBe(404);
    expect((await call(teamRoute.PATCH as never, `/api/teams/${team.id}`, "PATCH", { published: true }, cookie, { id: String(team.id) })).status).toBe(200);
    const pub = await call(teamRoute.GET as never, `/api/teams/${team.id}`, "GET", undefined, undefined, { id: String(team.id) });
    const seenPublic = ((await pub.json()) as { team: Team }).team;
    expect(seenPublic).toMatchObject({ name: "Route Team" });
    expect(seenPublic).not.toHaveProperty("roster");
    // A link, the invitation page's preview, then accepting.
    const link = await call(teamRoute.POST as never, `/api/teams/${team.id}`, "POST", { action: "inviteLink" }, cookie, { id: String(team.id) });
    expect(link.status).toBe(201);
    const token = tokenOf(((await link.json()) as { link: string }).link);
    const previewed = await call(invitationRoute.GET as never, `/api/team-invitations?token=${token}`, "GET", undefined, await as(stranger));
    expect(await previewed.json()).toMatchObject({ invitation: { team: "Route Team" } });
    expect((await call(invitationRoute.POST as never, "/api/team-invitations", "POST", { token }, await as(stranger))).status).toBe(201);
    const again = await call(invitationRoute.POST as never, "/api/team-invitations", "POST", { token }, await as(await adult()));
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "TM_INVITE_INVALID" });
    // The list: the teams you are on.
    const list = await call(teamsRoute.GET as never, "/api/teams", "GET", undefined, await as(stranger));
    expect(((await list.json()) as { teams: Team[] }).teams.map((x) => x.id)).toEqual([team.id]);
    // Bad action.
    expect((await call(teamRoute.POST as never, `/api/teams/${team.id}`, "POST", { action: "nonsense" }, cookie, { id: String(team.id) })).status).toBe(400);
  });
});

