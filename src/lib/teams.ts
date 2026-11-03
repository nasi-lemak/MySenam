import crypto from "crypto";
import { getDb, withTransaction } from "./db";
import { isActivity } from "./activities";
import { errorText, translator, type ErrorCode, type Vars } from "./i18n";
import { linkIn } from "./link-locale";
import { baseUrl, enqueue, accountLocale, emailPlayer, drainOutbox, sentences, type Written } from "./outbox";
import { keyedHash } from "./secrets";
import { invitationAddress } from "./player-invitations";
import { INVITES_PER_DAY, invitesToday } from "./games";
import { blockedBetween } from "./player-safety";
import { declaredAdult } from "./player-profiles";
import { guardianshipOf, participantEvent } from "./participants";
import { entrantMembership, entrantVenueRefusal } from "./competition-entrants";
import { categoryRefusal, categoryRefusalFor, isPartnerGender, type Category } from "./who";
import { isValidDateString, todayISO } from "./time";
import type { Refusal } from "./types";

/**
 * Teams that persist across events (docs/features/tournaments.md#teams;
 * migration 0269).
 *
 * A team is an entity of its own: a name, a sport, a captain, and members who
 * joined with their own accounts. It holds no court and no money. Tournaments
 * and team leagues take entries that name a team, and the roster for that
 * event is picked from the members, each checked against the event's rules
 * (`rosterRefusal`): an age range and a women's or men's category by what the
 * member declared (their word, never verified), a members-only or private
 * venue by the member's own standing there. The level is shown, not enforced,
 * as for every event.
 *
 * **Who joins how.** A member joins by accepting an invitation (by email, or a
 * link the captain shares, single use, run out after a fortnight), so both
 * sides have agreed; nobody is added. Being invited is for declared adults only
 * (ADR 0016), and every invitation that cannot be used is refused in the same
 * words, so an address is never shown to have an account. A child is never
 * invited and never has an account here: they are a participant their guardian
 * manages (ADR 0022/0023), put on a team only by the guardian's account (the
 * guardian accepting for them, or a captain adding their own child), whose
 * agreement is recorded as declared, never verified. A child's name is shown
 * to the captain and to their own guardian only; to other members, and to
 * anybody outside the team, the child is "a junior player".
 *
 * **Who sees what.** Members see the team and its roster; anybody sees only its
 * name and sport, and only if the captain published it. An event a team is
 * entered in shows the name the captain entered it as (the captain's act),
 * as a typed team always did.
 */

export const MAX_TEAMS_PER_CAPTAIN = 5;
export const TEAM_MAX_MEMBERS = 40;
export const TEAM_INVITE_DAYS = 14;
/** Left and removed members are kept this long for the team's own history, then forgotten. */
export const LEFT_MEMBER_KEEP_DAYS = 365;

export type TeamRefusal = Refusal & { status?: number };
export type TeamResult<T> = { ok: true; value: T } | TeamRefusal;

const ENGLISH = translator("en");
/** A refusal with its code, so every language says it, and the status a route answers with. */
export function teamRefusal(code: ErrorCode, vars: Record<string, string | number> = {}, status = 409): TeamRefusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(Object.keys(vars).length > 0 ? { vars } : {}), status };
}
const notFound = () => teamRefusal("TM_NOT_FOUND", {}, 404);
const invitationInvalid = () => teamRefusal("TM_INVITE_INVALID", {}, 404);

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export type MemberRole = "captain" | "member";

/** A person on a team, as the one looking may see them. */
export interface TeamMember {
  id: number;
  role: MemberRole;
  /** A first name for an adult; for a child, their name only to the captain and their own guardian ("a junior player" otherwise: `name` is null). */
  name: string | null;
  junior: boolean;
  /** Is this you, or somebody you act for? */
  mine: boolean;
  /** Said a date of birth / woman or man, for an event that asks (never shown: only whether). */
  birthDeclared: boolean;
  genderDeclared: boolean;
  /** For somebody you act for: the participant. */
  participantId?: number;
  joinedAt: string;
}

export interface TeamInvitationOut {
  id: number;
  kind: "email" | "link";
  expiresAt: string;
}

export interface Team {
  id: number;
  name: string;
  sport: string;
  venueId: number | null;
  venueName: string | null;
  groupId: number | null;
  groupName: string | null;
  description: string | null;
  published: boolean;
  status: "active" | "archived";
  captainName: string | null;
  members: number;
  /** Members only. */
  roster?: TeamMember[];
  /** The people on it this account is, or acts for. Empty for anybody else. */
  mine?: { memberId: number; participantId: number | null; role: MemberRole }[];
  isCaptain?: boolean;
  /** For the captain: invitations out and not yet used. */
  invitations?: TeamInvitationOut[];
}

interface TeamRow {
  id: number;
  name: string;
  sport: string;
  venue_id: number | null;
  venue_name: string | null;
  group_id: number | null;
  group_name: string | null;
  description: string | null;
  published: boolean;
  status: "active" | "archived";
  captain_user_id: number | null;
  captain_name: string | null;
  members: number;
}

const TEAM_SELECT = `
  SELECT t.id, t.name, t.sport, t.venue_id, v.name AS venue_name, t.group_id, g.name AS group_name, t.description, t.published, t.status,
         t.captain_user_id, u.name AS captain_name,
         (SELECT COUNT(*)::int FROM team_members m WHERE m.team_id = t.id AND m.status = 'member') AS members
    FROM teams t
    LEFT JOIN venues v ON v.id = t.venue_id
    LEFT JOIN community_groups g ON g.id = t.group_id
    LEFT JOIN users u ON u.id = t.captain_user_id`;

const toTeam = (r: TeamRow): Team => ({
  id: r.id,
  name: r.name,
  sport: r.sport,
  venueId: r.venue_id,
  venueName: r.venue_name,
  groupId: r.group_id,
  groupName: r.group_name,
  description: r.description,
  published: r.published === true,
  status: r.status,
  captainName: r.captain_name ? firstName(r.captain_name) : null,
  members: r.members,
});

export async function teamRow(id: number): Promise<(Team & { captainUserId: number | null }) | null> {
  const r = (await getDb().prepare(`${TEAM_SELECT} WHERE t.id = ?`).get(id)) as TeamRow | undefined;
  return r ? { ...toTeam(r), captainUserId: r.captain_user_id } : null;
}

interface MemberRow {
  id: number;
  team_id: number;
  user_id: number | null;
  participant_id: number | null;
  acting_user_id: number | null;
  role: MemberRole;
  status: "member" | "left" | "removed";
  birth_date: string | null;
  gender: "woman" | "man" | null;
  agreed_at: string | null;
  joined_at: string;
  user_name: string | null;
  participant_name: string | null;
}

const MEMBER_SELECT = `
  SELECT m.id, m.team_id, m.user_id, m.participant_id, m.acting_user_id, m.role, m.status, m.birth_date, m.gender, m.agreed_at, m.joined_at,
         u.name AS user_name, p.display_name AS participant_name
    FROM team_members m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN participants p ON p.id = m.participant_id`;

async function memberRow(id: number): Promise<MemberRow | undefined> {
  return (await getDb().prepare(`${MEMBER_SELECT} WHERE m.id = ?`).get(id)) as MemberRow | undefined;
}

async function liveMembers(teamId: number): Promise<MemberRow[]> {
  return (await getDb().prepare(`${MEMBER_SELECT} WHERE m.team_id = ? AND m.status = 'member' ORDER BY (m.role = 'captain') DESC, m.id`).all(teamId)) as MemberRow[];
}

/** Is this account the member, or the guardian acting for the child who is? */
const actsAs = (m: MemberRow, userId: number) => m.user_id === userId || m.acting_user_id === userId;

/** The members of a team this account is or acts for. */
async function myMembers(teamId: number, userId: number): Promise<MemberRow[]> {
  return (await getDb()
    .prepare(`${MEMBER_SELECT} WHERE m.team_id = ? AND m.status = 'member' AND (m.user_id = ? OR m.acting_user_id = ?) ORDER BY m.id`)
    .all(teamId, userId, userId)) as MemberRow[];
}

// ------------------------------------------------------------ what people see

/**
 * One team as this person may see it: its members see the roster (a child
 * named only to the captain and their own guardian); anybody else sees a
 * published, active team by name and sport, and nothing else; a team not
 * published is not found for anybody who is not on it.
 */
export async function teamView(teamId: number, viewerId: number | null): Promise<Team | null> {
  const base = await teamRow(teamId);
  if (!base) return null;
  const { captainUserId, ...team } = base;
  const mine = viewerId === null ? [] : await myMembers(teamId, viewerId);
  if (mine.length === 0) {
    if (!team.published || team.status !== "active") return null;
    return { id: team.id, name: team.name, sport: team.sport, venueId: team.venueId, venueName: team.venueName, groupId: null, groupName: null, description: null, published: true, status: "active", captainName: null, members: 0 };
  }
  const captain = viewerId !== null && captainUserId === viewerId;
  const roster = (await liveMembers(teamId)).map((m) => {
    const junior = m.participant_id !== null;
    const own = viewerId !== null && actsAs(m, viewerId);
    return {
      id: m.id,
      role: m.role,
      name: junior ? (captain || own ? m.participant_name : null) : m.user_name ? firstName(m.user_name) : null,
      junior,
      mine: own,
      birthDeclared: m.birth_date !== null,
      genderDeclared: m.gender !== null,
      ...(junior && (captain || own) ? { participantId: m.participant_id! } : {}),
      joinedAt: m.joined_at,
    } satisfies TeamMember;
  });
  return {
    ...team,
    roster,
    mine: mine.map((m) => ({ memberId: m.id, participantId: m.participant_id, role: m.role })),
    isCaptain: captain,
    ...(captain ? { invitations: await openInvitations(teamId) } : {}),
  };
}

/** Every team this account is on, or acts for a child who is: active first, then archived. */
export async function myTeams(userId: number): Promise<Team[]> {
  const ids = (await getDb()
    .prepare(
      `SELECT DISTINCT t.id, t.status FROM teams t JOIN team_members m ON m.team_id = t.id
        WHERE m.status = 'member' AND (m.user_id = ? OR m.acting_user_id = ?) ORDER BY t.status, t.id`
    )
    .all(userId, userId)) as { id: number }[];
  const out: Team[] = [];
  for (const { id } of ids) {
    const t = await teamView(id, userId);
    if (t) out.push(t);
  }
  return out;
}

/** The teams this account captains, active, for choosing one to enter an event. */
export async function captainedTeams(userId: number, sport?: string): Promise<{ id: number; name: string; sport: string; members: number }[]> {
  const rows = (await getDb()
    .prepare(
      `${TEAM_SELECT} WHERE t.captain_user_id = ? AND t.status = 'active' ${sport ? "AND t.sport = ?" : ""} ORDER BY t.name`
    )
    .all(...(sport ? [userId, sport] : [userId]))) as TeamRow[];
  return rows.map((r) => ({ id: r.id, name: r.name, sport: r.sport, members: r.members }));
}

// ------------------------------------------------------------ making and changing one

function cleanName(v: unknown): string | null {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return name.length >= 3 && name.length <= 60 ? name : null;
}

/** Only a declared adult runs a team: it invites people, and being invited is for adults (ADR 0016). */
async function adultRefusal(userId: number): Promise<TeamRefusal | null> {
  return (await declaredAdult(userId)) === true ? null : teamRefusal("TM_ADULT_ONLY", {}, 403);
}

export interface TeamInput {
  name?: unknown;
  sport?: unknown;
  venueId?: unknown;
  groupId?: unknown;
  description?: unknown;
  published?: unknown;
}

async function placeRefusals(userId: number, input: TeamInput): Promise<TeamRefusal | { venueId: number | null; groupId: number | null }> {
  let venueId: number | null = null;
  if (input.venueId !== undefined && input.venueId !== null && input.venueId !== "") {
    const id = Number(input.venueId);
    const found = Number.isInteger(id) ? await getDb().prepare("SELECT 1 FROM venues WHERE id = ?").get(id) : undefined;
    if (!found) return teamRefusal("TM_VENUE", {}, 400);
    venueId = id;
  }
  let groupId: number | null = null;
  if (input.groupId !== undefined && input.groupId !== null && input.groupId !== "") {
    const id = Number(input.groupId);
    const mine = Number.isInteger(id)
      ? await getDb().prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'member'").get(id, userId)
      : undefined;
    if (!mine) return teamRefusal("TM_GROUP", {}, 400);
    groupId = id;
  }
  return { venueId, groupId };
}

/** A new team, its creator the captain and its first member. */
export async function createTeam(userId: number, input: TeamInput): Promise<TeamResult<Team>> {
  const adult = await adultRefusal(userId);
  if (adult) return adult;
  const name = cleanName(input.name);
  if (!name) return teamRefusal("TM_NAME", {}, 400);
  if (typeof input.sport !== "string" || !(await isActivity(input.sport))) return teamRefusal("TM_SPORT", {}, 400);
  const place = await placeRefusals(userId, input);
  if ("ok" in place) return place;
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null;
  return withTransaction(async (): Promise<TeamResult<Team>> => {
    const db = getDb();
    // One captain's teams are counted and made together, under their own row.
    await db.prepare("SELECT id FROM users WHERE id = ? FOR UPDATE").get(userId);
    const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM teams WHERE captain_user_id = ? AND status = 'active'").get(userId)) as { n: number };
    if (n >= MAX_TEAMS_PER_CAPTAIN) return teamRefusal("TM_TOO_MANY", { n: MAX_TEAMS_PER_CAPTAIN });
    const same = await db.prepare("SELECT 1 FROM teams WHERE captain_user_id = ? AND status = 'active' AND lower(name) = lower(?)").get(userId, name);
    if (same) return teamRefusal("TM_NAME_TAKEN");
    const made = (await db
      .prepare("INSERT INTO teams (name, sport, venue_id, group_id, captain_user_id, description, published) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(name, input.sport, place.venueId, place.groupId, userId, description, input.published === true)) as { id: number };
    await db.prepare("INSERT INTO team_members (team_id, user_id, role, status) VALUES (?, ?, 'captain', 'member')").run(made.id, userId);
    return { ok: true, value: (await teamView(made.id, userId))! };
  });
}

/** The captain's changes to the team: its name, details, venue, group and whether it is published. */
export async function updateTeam(userId: number, teamId: number, input: TeamInput): Promise<TeamResult<Team>> {
  const team = await teamRow(teamId);
  if (!team || !(await myMembers(teamId, userId)).length) return notFound();
  if (team.captainUserId !== userId) return teamRefusal("TM_CAPTAIN_ONLY", {}, 403);
  if (team.status !== "active") return teamRefusal("TM_ARCHIVED");
  const sets: string[] = [];
  const args: (string | number | boolean | null)[] = [];
  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (!name) return teamRefusal("TM_NAME", {}, 400);
    const same = await getDb().prepare("SELECT 1 FROM teams WHERE captain_user_id = ? AND status = 'active' AND lower(name) = lower(?) AND id <> ?").get(userId, name, teamId);
    if (same) return teamRefusal("TM_NAME_TAKEN");
    sets.push("name = ?");
    args.push(name);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    args.push(typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null);
  }
  if (input.venueId !== undefined || input.groupId !== undefined) {
    const place = await placeRefusals(userId, { venueId: input.venueId ?? team.venueId, groupId: input.groupId ?? team.groupId });
    if ("ok" in place) return place;
    if (input.venueId !== undefined) {
      sets.push("venue_id = ?");
      args.push(place.venueId);
    }
    if (input.groupId !== undefined) {
      sets.push("group_id = ?");
      args.push(place.groupId);
    }
  }
  if (input.published !== undefined) {
    sets.push("published = ?");
    args.push(input.published === true);
  }
  if (sets.length > 0) await getDb().prepare(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?`).run(...args, teamId);
  return { ok: true, value: (await teamView(teamId, userId))! };
}

// ------------------------------------------------------------ telling people

/** An email to the account behind a member: a child's goes to the guardian, saying whose it is. */
async function tellMember(m: MemberRow, venueId: number | null, subject: Written, body: Written, link: string): Promise<void> {
  const to = m.participant_id !== null ? m.acting_user_id : m.user_id;
  if (to === null) return;
  const forName = m.participant_id !== null ? m.participant_name : null;
  await emailPlayer({
    venueId,
    userId: to,
    subject,
    body: (tr) => sentences(tr, forName && tr("tm.mail.for", { name: forName }), body(tr)),
    link,
  });
}

/** Everybody on the team (a child's guardian for them) is told, but for the one who acted. */
export async function tellTeam(teamId: number, subject: Written, body: Written, opts: { except?: number[]; link?: string } = {}): Promise<void> {
  const t = await teamRow(teamId);
  if (!t) return;
  for (const m of await liveMembers(teamId)) {
    if (opts.except?.includes(m.id)) continue;
    await tellMember(m, null, subject, body, opts.link ?? `${baseUrl()}/teams/${teamId}`);
  }
}

async function tellCaptain(teamId: number, subject: Written, body: Written): Promise<void> {
  const t = await teamRow(teamId);
  if (!t?.captainUserId) return;
  await emailPlayer({ venueId: null, userId: t.captainUserId, subject, body, link: `${baseUrl()}/teams/${teamId}` });
}

// ------------------------------------------------------------ invitations

const tokenHash = (token: string) => keyedHash("team-invitation", token);
const emailHash = (email: string) => keyedHash("team-invitation-email", email.trim().toLowerCase());
const newToken = () => crypto.randomBytes(24).toString("base64url");

async function teamInvitesToday(userId: number): Promise<number> {
  const row = (await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM team_invitations WHERE invited_by = ? AND created_at >= datetime('now', '-1 day')")
    .get(userId)) as { n: number };
  return row.n;
}

/** Invitations count against the one daily limit, with those to games and groups. */
async function overInviteLimit(userId: number): Promise<boolean> {
  return (await invitesToday(userId)) + (await teamInvitesToday(userId)) >= INVITES_PER_DAY;
}

async function openInvitations(teamId: number): Promise<TeamInvitationOut[]> {
  const rows = (await getDb()
    .prepare("SELECT id, kind, expires_at FROM team_invitations WHERE team_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now') ORDER BY id")
    .all(teamId)) as { id: number; kind: "email" | "link"; expires_at: string }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, expiresAt: r.expires_at }));
}

/** The captain of an active team, or why not (a refusal that does not say whether the team exists to anybody else). */
async function captainOf(userId: number, teamId: number): Promise<TeamResult<{ name: string; full: boolean }>> {
  const team = await teamRow(teamId);
  if (!team || !(await myMembers(teamId, userId)).length) return notFound();
  if (team.captainUserId !== userId) return teamRefusal("TM_CAPTAIN_ONLY", {}, 403);
  if (team.status !== "active") return teamRefusal("TM_ARCHIVED");
  return { ok: true, value: { name: team.name, full: team.members >= TEAM_MAX_MEMBERS } };
}

const expiry = async () => ((await getDb().prepare(`SELECT datetime('now', '+${TEAM_INVITE_DAYS} days') AS at`).get()) as { at: string }).at;

/**
 * The captain inviting somebody by email. The address is never looked up:
 * whoever holds it and whether or not they may be invited, the answer and the
 * work done are the same (docs/architecture/security.md#no-account-enumeration).
 * The email carries a single-use link; the captain sees "invited" and when it
 * runs out, never who.
 */
export async function inviteByEmail(captainId: number, teamId: number, email: unknown): Promise<TeamResult<{ invitations: TeamInvitationOut[] }>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  const address = await invitationAddress(captainId, email);
  if (!address.ok) return { ...address, status: 400 };
  if (await overInviteLimit(captainId)) return teamRefusal("TM_INVITES_TODAY", {}, 429);
  const token = newToken();
  const expiresAt = await expiry();
  const by = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(captainId)) as { name: string };
  await withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT id FROM teams WHERE id = ? FOR UPDATE").get(teamId);
    // Inviting the same address again replaces the link.
    await db.prepare("UPDATE team_invitations SET cancelled_at = datetime('now') WHERE team_id = ? AND email_hash = ? AND used_at IS NULL AND cancelled_at IS NULL").run(teamId, emailHash(address.email));
    await db
      .prepare("INSERT INTO team_invitations (team_id, invited_by, kind, token_hash, email_hash, expires_at) VALUES (?, ?, 'email', ?, ?, ?)")
      .run(teamId, captainId, tokenHash(token), emailHash(address.email), expiresAt);
    const locale = await accountLocale(captainId);
    await enqueue({
      venueId: null,
      kind: "account_email",
      channel: "email",
      recipient: address.email,
      locale,
      subject: "tm.mail.invite.s",
      body: "tm.mail.invite.b",
      vars: { by: firstName(by.name), team: cap.value.name, days: TEAM_INVITE_DAYS, link: linkIn(`${baseUrl()}/team-invitation?token=${token}`, locale) },
      expiresMinutes: TEAM_INVITE_DAYS * 24 * 60,
    });
  });
  void drainOutbox().catch(() => null);
  return { ok: true, value: { invitations: await openInvitations(teamId) } };
}

/**
 * A link the captain shares however they like (a message, WhatsApp), shown
 * once: only its hash is kept. Whoever opens it signed in, a declared adult,
 * may accept it, once.
 */
export async function createInviteLink(captainId: number, teamId: number): Promise<TeamResult<{ link: string; expiresAt: string; invitations: TeamInvitationOut[] }>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  if (await overInviteLimit(captainId)) return teamRefusal("TM_INVITES_TODAY", {}, 429);
  const token = newToken();
  const expiresAt = await expiry();
  await getDb()
    .prepare("INSERT INTO team_invitations (team_id, invited_by, kind, token_hash, expires_at) VALUES (?, ?, 'link', ?, ?)")
    .run(teamId, captainId, tokenHash(token), expiresAt);
  return { ok: true, value: { link: `${baseUrl()}/team-invitation?token=${token}`, expiresAt, invitations: await openInvitations(teamId) } };
}

/** The captain withdrawing an invitation not yet used: its link then fails like any other that cannot be used. */
export async function withdrawInvitation(captainId: number, teamId: number, invitationId: unknown): Promise<TeamResult<{ invitations: TeamInvitationOut[] }>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  if (!Number.isInteger(invitationId)) return invitationInvalid();
  const done = await getDb()
    .prepare("UPDATE team_invitations SET cancelled_at = datetime('now') WHERE id = ? AND team_id = ? AND used_at IS NULL AND cancelled_at IS NULL")
    .run(invitationId as number, teamId);
  if (done.changes !== 1) return invitationInvalid();
  return { ok: true, value: { invitations: await openInvitations(teamId) } };
}

interface InvitationRow {
  id: number;
  team_id: number;
  invited_by: number | null;
  kind: "email" | "link";
  email_hash: string | null;
}

/** The invitation a link carries, if this account may use it now; null for every other reason alike. */
async function usableInvitation(user: { id: number; email: string }, token: unknown): Promise<InvitationRow | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = (await getDb()
    .prepare(
      `SELECT id, team_id, invited_by, kind, email_hash FROM team_invitations
        WHERE token_hash = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now')`
    )
    .get(tokenHash(token))) as InvitationRow | undefined;
  if (!row || row.invited_by === null || row.invited_by === user.id) return null;
  if (row.kind === "email" && row.email_hash !== emailHash(user.email)) return null;
  return row;
}

/** May this account be invited by this captain: a declared adult, not across a block, to a team that is still there and has room. */
async function mayAccept(user: { id: number }, inv: InvitationRow): Promise<boolean> {
  if ((await declaredAdult(user.id)) !== true) return false;
  if (inv.invited_by !== null && (await blockedBetween(inv.invited_by, user.id))) return false;
  const team = await teamRow(inv.team_id);
  return !!team && team.status === "active" && team.captainUserId === inv.invited_by;
}

export interface InvitationPreview {
  team: string;
  sport: string;
  by: string;
  /** The people this account manages, who could be put on the team instead of the account holder. */
  canActFor: { participantId: number; name: string }[];
}

/**
 * What an invitation is for, to the account it is for: the team's name, the
 * captain's first name, and the people they manage (a child is put on a team
 * by the guardian, through this). Anything that cannot be used is refused in
 * the same words.
 */
export async function previewInvitation(user: { id: number; email: string }, token: unknown): Promise<TeamResult<InvitationPreview>> {
  const inv = await usableInvitation(user, token);
  if (!inv || !(await mayAccept(user, inv))) return invitationInvalid();
  const team = (await teamRow(inv.team_id))!;
  const by = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(inv.invited_by!)) as { name: string };
  const { guardianshipsOf } = await import("./participants");
  const kids = await guardianshipsOf(user.id);
  return { ok: true, value: { team: team.name, sport: team.sport, by: firstName(by.name), canActFor: kids.map((k) => ({ participantId: k.participant.id, name: k.participant.displayName })) } };
}

/** What a member says about themselves, only so an event's age range and category can be checked: their word. */
export interface MemberDeclaration {
  birthDate?: unknown;
  gender?: unknown;
}

function readDeclaration(d: MemberDeclaration): TeamRefusal | { birthDate: string | null; gender: "woman" | "man" | null } {
  let birthDate: string | null = null;
  if (d.birthDate !== undefined && d.birthDate !== null && d.birthDate !== "") {
    if (typeof d.birthDate !== "string" || !isValidDateString(d.birthDate) || d.birthDate >= todayISO()) return teamRefusal("TM_BIRTH", {}, 400);
    birthDate = d.birthDate;
  }
  let gender: "woman" | "man" | null = null;
  if (d.gender !== undefined && d.gender !== null && d.gender !== "") {
    if (!isPartnerGender(d.gender)) return teamRefusal("TM_GENDER", {}, 400);
    gender = d.gender;
  }
  return { birthDate, gender };
}

/**
 * Accept an invitation, signed in with the account it is for, for oneself or,
 * where `participantId` is given, for a child the account manages (their
 * guardian's agreement, recorded as declared). Both sides agreeing makes them
 * a member, if there is room; the invitation is spent only then.
 */
export async function acceptInvitation(
  user: { id: number; email: string; name: string },
  token: unknown,
  input: { participantId?: unknown } & MemberDeclaration = {}
): Promise<TeamResult<{ teamId: number; name: string }>> {
  const inv = await usableInvitation(user, token);
  if (!inv || !(await mayAccept(user, inv))) return invitationInvalid();
  const declared = readDeclaration(input);
  if ("ok" in declared) return declared;
  let participant: { id: number; name: string } | null = null;
  if (input.participantId !== undefined && input.participantId !== null && input.participantId !== "") {
    const mine = await guardianshipOf(user.id, input.participantId, { live: true });
    if (!mine) return teamRefusal("TM_NOT_YOURS", {}, 404);
    participant = { id: mine.participant.id, name: mine.participant.displayName };
  }
  const done = await withTransaction(async (): Promise<TeamResult<{ teamId: number; name: string; memberId: number }>> => {
    const db = getDb();
    await db.prepare("SELECT id FROM teams WHERE id = ? FOR UPDATE").get(inv.team_id);
    const team = await teamRow(inv.team_id);
    if (!team || team.status !== "active") return invitationInvalid();
    const already = participant
      ? await db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND participant_id = ? AND status = 'member'").get(inv.team_id, participant.id)
      : await db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'member'").get(inv.team_id, user.id);
    if (already) return teamRefusal("TM_ALREADY", { name: participant ? participant.name : firstName(user.name) });
    if (team.members >= TEAM_MAX_MEMBERS) return teamRefusal("TM_FULL", { n: TEAM_MAX_MEMBERS });
    const spent = await db
      .prepare(
        `UPDATE team_invitations SET used_at = datetime('now'), used_by = ?
          WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now')`
      )
      .run(user.id, inv.id);
    if (spent.changes !== 1) return invitationInvalid();
    const made = (await db
      .prepare(
        `INSERT INTO team_members (team_id, user_id, participant_id, acting_user_id, role, status, birth_date, gender, agreed_at, invited_by)
         VALUES (?, ?, ?, ?, 'member', 'member', ?, ?, ${participant ? "datetime('now')" : "NULL"}, ?) RETURNING id`
      )
      .get(inv.team_id, participant ? null : user.id, participant?.id ?? null, participant ? user.id : null, declared.birthDate, declared.gender, inv.invited_by)) as { id: number };
    if (participant)
      await participantEvent(participant.id, "team.joined", { userId: user.id, name: user.name }, { detail: team.name });
    return { ok: true, value: { teamId: team.id, name: team.name, memberId: made.id } };
  });
  if (!done.ok) return done;
  const who = participant ? participant.name : firstName(user.name);
  await tellCaptain(
    done.value.teamId,
    (tr) => tr("tm.mail.joined.s", { team: done.value.name, name: who }),
    (tr) => tr("tm.mail.joined.b", { team: done.value.name, name: who })
  );
  return { ok: true, value: { teamId: done.value.teamId, name: done.value.name } };
}

/** The captain putting a child they manage themselves on the team: their own agreement, as the child's guardian. */
export async function addOwnChild(captainId: number, teamId: number, participantId: unknown, declared: MemberDeclaration = {}): Promise<TeamResult<Team>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  const mine = await guardianshipOf(captainId, participantId, { live: true });
  if (!mine) return teamRefusal("TM_NOT_YOURS", {}, 404);
  const said = readDeclaration(declared);
  if ("ok" in said) return said;
  const done = await withTransaction(async (): Promise<TeamResult<null>> => {
    const db = getDb();
    await db.prepare("SELECT id FROM teams WHERE id = ? FOR UPDATE").get(teamId);
    const team = await teamRow(teamId);
    if (!team || team.status !== "active") return notFound();
    if (await db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND participant_id = ? AND status = 'member'").get(teamId, mine.participant.id))
      return teamRefusal("TM_ALREADY", { name: mine.participant.displayName });
    if (team.members >= TEAM_MAX_MEMBERS) return teamRefusal("TM_FULL", { n: TEAM_MAX_MEMBERS });
    await db
      .prepare(
        `INSERT INTO team_members (team_id, participant_id, acting_user_id, role, status, birth_date, gender, agreed_at, invited_by)
         VALUES (?, ?, ?, 'member', 'member', ?, ?, datetime('now'), ?)`
      )
      .run(teamId, mine.participant.id, captainId, said.birthDate, said.gender, captainId);
    await participantEvent(mine.participant.id, "team.joined", { userId: captainId }, { detail: team.name });
    return { ok: true, value: null };
  });
  if (!done.ok) return done;
  return { ok: true, value: (await teamView(teamId, captainId))! };
}

// ------------------------------------------------------------ leaving, removing, handing over

/** Drop a member from the event rosters not yet played (a tournament not drawn, a league not yet scheduled), and tell the captain of any roster that is now short. */
async function dropFromRosters(memberId: number, why: "left" | "removed"): Promise<void> {
  const db = getDb();
  const m = await memberRow(memberId);
  if (!m) return;
  const entries = (await db
    .prepare(
      `SELECT x.id AS row_id, e.id AS entry_id, t.name AS event, t.roster_min AS min, e.team_id
         FROM tournament_entry_members x JOIN tournament_entries e ON e.id = x.entry_id JOIN tournaments t ON t.id = e.tournament_id
        WHERE x.team_member_id = ? AND e.status <> 'withdrawn' AND t.status IN ('open', 'closed')`
    )
    .all(memberId)) as { row_id: number; entry_id: number; event: string; min: number | null; team_id: number }[];
  for (const e of entries) {
    await db.prepare("DELETE FROM tournament_entry_members WHERE id = ?").run(e.row_id);
    const names = (await db.prepare("SELECT name FROM tournament_entry_members WHERE entry_id = ? ORDER BY id").all(e.entry_id)) as { name: string }[];
    await db.prepare("UPDATE tournament_entries SET roster = ? WHERE id = ?").run(JSON.stringify(names.map((n) => n.name)), e.entry_id);
    if (e.min !== null && names.length < e.min)
      await tellCaptain(
        e.team_id,
        (tr) => tr("tm.mail.short.s", { event: e.event }),
        (tr) => tr("tm.mail.short.b", { event: e.event, n: names.length, min: e.min! })
      );
  }
  const { dropFromLeagueRosters } = await import("./team-leagues");
  await dropFromLeagueRosters(memberId, why);
}

async function endMembership(m: MemberRow, status: "left" | "removed"): Promise<void> {
  await getDb().prepare("UPDATE team_members SET status = ?, left_at = datetime('now'), role = 'member' WHERE id = ?").run(status, m.id);
  await dropFromRosters(m.id, status);
}

/**
 * Leave a team: the member themself, or the guardian for a child. The captain
 * hands the team to somebody else first (or archives it); leaving takes the
 * member off event rosters not yet played, as it does for a team entered in
 * an event. What was played stays in the team's history.
 */
export async function leaveTeam(userId: number, teamId: number, participantId?: unknown): Promise<TeamResult<null>> {
  const rows = await myMembers(teamId, userId);
  const m = participantId === undefined || participantId === null ? rows.find((r) => r.user_id === userId) : rows.find((r) => r.participant_id === Number(participantId));
  if (!m) return teamRefusal("TM_NOT_MEMBER", {}, 404);
  if (m.role === "captain") return teamRefusal("TM_CAPTAIN_LEAVES");
  await withTransaction(async () => {
    await getDb().prepare("SELECT id FROM teams WHERE id = ? FOR UPDATE").get(teamId);
    await endMembership(m, "left");
  });
  const team = (await teamRow(teamId))!;
  const who = m.participant_id !== null ? m.participant_name! : firstName(m.user_name ?? "");
  await tellCaptain(
    teamId,
    (tr) => tr("tm.mail.left.s", { team: team.name, name: who }),
    (tr) => tr("tm.mail.left.b", { team: team.name, name: who })
  );
  return { ok: true, value: null };
}

/** The captain taking somebody off the team. */
export async function removeMember(captainId: number, teamId: number, memberId: unknown): Promise<TeamResult<Team>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  const m = Number.isInteger(memberId) ? await memberRow(memberId as number) : undefined;
  if (!m || m.team_id !== teamId || m.status !== "member") return teamRefusal("TM_NOT_MEMBER", {}, 404);
  if (m.role === "captain") return teamRefusal("TM_CAPTAIN_LEAVES");
  await withTransaction(async () => {
    await getDb().prepare("SELECT id FROM teams WHERE id = ? FOR UPDATE").get(teamId);
    await endMembership(m, "removed");
  });
  await tellMember(
    m,
    null,
    (tr) => tr("tm.mail.removed.s", { team: cap.value.name }),
    (tr) => tr("tm.mail.removed.b", { team: cap.value.name }),
    `${baseUrl()}/teams`
  );
  return { ok: true, value: (await teamView(teamId, captainId))! };
}

/**
 * The captain handing the team to a member with an account of their own who
 * has said they are 18 or over. At once, and the new captain is told; the old
 * one stays a member.
 */
export async function transferCaptain(captainId: number, teamId: number, toMemberId: unknown): Promise<TeamResult<Team>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  const to = Number.isInteger(toMemberId) ? await memberRow(toMemberId as number) : undefined;
  if (!to || to.team_id !== teamId || to.status !== "member") return teamRefusal("TM_NOT_MEMBER", {}, 404);
  if (to.user_id === null || to.role === "captain" || (await declaredAdult(to.user_id)) !== true) return teamRefusal("TM_TRANSFER_TO");
  await withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT id FROM teams WHERE id = ? FOR UPDATE").get(teamId);
    await db.prepare("UPDATE team_members SET role = 'member' WHERE team_id = ? AND role = 'captain' AND status = 'member'").run(teamId);
    await db.prepare("UPDATE team_members SET role = 'captain' WHERE id = ?").run(to.id);
    await db.prepare("UPDATE teams SET captain_user_id = ? WHERE id = ?").run(to.user_id, teamId);
  });
  await tellMember(
    to,
    null,
    (tr) => tr("tm.mail.captain.s", { team: cap.value.name }),
    (tr) => tr("tm.mail.captain.b", { team: cap.value.name }),
    `${baseUrl()}/teams/${teamId}`
  );
  // The old captain is a member still, and may see the team as one.
  return { ok: true, value: (await teamView(teamId, captainId))! };
}

/** The events a team is still entered in, which stop it being archived (names for the refusal). */
async function liveEntries(teamId: number): Promise<string[]> {
  const db = getDb();
  const tournaments = (await db
    .prepare(
      `SELECT t.name FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
        WHERE e.team_id = ? AND e.status <> 'withdrawn' AND t.status IN ('open', 'closed', 'drawn')`
    )
    .all(teamId)) as { name: string }[];
  const leagues = (await db
    .prepare(
      `SELECT l.name FROM team_league_teams x JOIN team_leagues l ON l.id = x.league_id
        WHERE x.team_id = ? AND x.status = 'entered' AND l.status IN ('forming', 'scheduled')`
    )
    .all(teamId)) as { name: string }[];
  return [...tournaments, ...leagues].map((r) => r.name);
}

/** The captain archiving the team: not while it is entered in an event still to be played (withdraw it first). Nothing is deleted. */
export async function archiveTeam(captainId: number, teamId: number): Promise<TeamResult<Team>> {
  const cap = await captainOf(captainId, teamId);
  if (!cap.ok) return cap;
  const entered = await liveEntries(teamId);
  if (entered.length > 0) return teamRefusal("TM_ARCHIVE_ENTERED", { team: cap.value.name, event: entered[0] });
  await getDb().prepare("UPDATE teams SET status = 'archived', archived_at = datetime('now'), published = false WHERE id = ?").run(teamId);
  await tellTeam(
    teamId,
    (tr) => tr("tm.mail.archived.s", { team: cap.value.name }),
    (tr) => tr("tm.mail.archived.b", { team: cap.value.name }),
    { except: [] }
  );
  return { ok: true, value: (await teamView(teamId, captainId))! };
}

/** Bringing an archived team back, if its captain still has room for another. */
export async function restoreTeam(captainId: number, teamId: number): Promise<TeamResult<Team>> {
  const team = await teamRow(teamId);
  if (!team || team.captainUserId !== captainId) return notFound();
  if (team.status !== "archived") return { ok: true, value: (await teamView(teamId, captainId))! };
  const { n } = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM teams WHERE captain_user_id = ? AND status = 'active'").get(captainId)) as { n: number };
  if (n >= MAX_TEAMS_PER_CAPTAIN) return teamRefusal("TM_TOO_MANY", { n: MAX_TEAMS_PER_CAPTAIN });
  const clash = await getDb().prepare("SELECT 1 FROM teams WHERE captain_user_id = ? AND status = 'active' AND lower(name) = lower(?)").get(captainId, team.name);
  if (clash) return teamRefusal("TM_NAME_TAKEN");
  await getDb().prepare("UPDATE teams SET status = 'active', archived_at = NULL WHERE id = ?").run(teamId);
  return { ok: true, value: (await teamView(teamId, captainId))! };
}

/** A member (or the guardian of a child member) changing what they declared about themself: a date of birth, woman or man. */
export async function setMemberDetails(userId: number, memberId: unknown, input: MemberDeclaration): Promise<TeamResult<Team>> {
  const m = Number.isInteger(memberId) ? await memberRow(memberId as number) : undefined;
  if (!m || m.status !== "member" || !actsAs(m, userId)) return teamRefusal("TM_NOT_MEMBER", {}, 404);
  const said = readDeclaration({ birthDate: input.birthDate ?? "", gender: input.gender ?? "" });
  if ("ok" in said) return said;
  await getDb()
    .prepare("UPDATE team_members SET birth_date = ?, gender = ? WHERE id = ?")
    .run(input.birthDate === undefined ? m.birth_date : said.birthDate, input.gender === undefined ? m.gender : said.gender, m.id);
  return { ok: true, value: (await teamView(m.team_id, userId))! };
}

// ------------------------------------------------------------ naming a team in an event

export interface EventRules {
  venueId: number;
  name: string;
  sport: string;
  category: Category;
  ageRange: { min: number | null; max: number | null } | null;
  /** The first day: ages are on this day. */
  startsOn: string;
  membersOnly: boolean;
}

export interface PickedMember {
  memberId: number;
  name: string;
  declaredMinor: boolean;
  guardianAgreedAt: string | null;
  userId: number | null;
}

const ageText = (r: { min: number | null; max: number | null }) => (r.min !== null && r.max !== null ? `${r.min} to ${r.max}` : r.min !== null ? `${r.min} and over` : `${r.max} and under`);

function ageOn(birthDate: string, day: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** The age at which an entry needs a guardian's agreement (lib/tournaments.ts `GUARDIAN_AGE`). */
const MINOR_AGE = 18;

/**
 * Whether these members of a team may be on the roster of an event, each by
 * the event's own rules and what each declared (never verified): an age range
 * on the first day, a women's or men's category, a members-only venue's
 * membership, a private venue's list. A child is a member through their
 * guardian's agreement, recorded when they joined. The level is shown, not
 * enforced. Refused naming the first member who does not fit, and why.
 */
export async function rosterRefusal(
  teamId: number,
  memberIds: unknown,
  rules: EventRules,
  today: string,
  opts: { min?: number; max?: number } = {}
): Promise<TeamResult<PickedMember[]>> {
  const ids = Array.isArray(memberIds) ? [...new Set(memberIds.filter((x): x is number => Number.isInteger(x)))] : [];
  if (ids.length !== (Array.isArray(memberIds) ? memberIds.length : 0)) return teamRefusal("TM_PICK_BAD", {}, 400);
  const min = opts.min ?? 1;
  const max = opts.max ?? TEAM_MAX_MEMBERS;
  if (ids.length < min || ids.length > max) return teamRefusal("TM_ROSTER_SIZE", { min, max });
  const live = new Map((await liveMembers(teamId)).map((m) => [m.id, m]));
  const picked: PickedMember[] = [];
  for (const id of ids) {
    const m = live.get(id);
    if (!m) return teamRefusal("TM_PICK_NOT_ON");
    const name = m.participant_id !== null ? m.participant_name ?? "" : m.user_name ?? "";
    let minor = false;
    if (rules.ageRange) {
      if (!m.birth_date || m.birth_date >= rules.startsOn) return teamRefusal("TM_MEMBER_BIRTH", { name, range: ageText(rules.ageRange) });
      const age = ageOn(m.birth_date, rules.startsOn);
      if ((rules.ageRange.min !== null && age < rules.ageRange.min) || (rules.ageRange.max !== null && age > rules.ageRange.max))
        return teamRefusal("TM_MEMBER_AGE", { name, age, date: rules.startsOn, range: ageText(rules.ageRange) });
      minor = age < MINOR_AGE;
      // A young player is on a team through a guardian's account: an account that says under 18 is not.
      if (minor && m.participant_id === null) return teamRefusal("TM_MEMBER_MINOR_ACCOUNT", { name });
    }
    if (rules.category !== "open") {
      const pair = null;
      const refusal =
        m.participant_id === null
          ? await categoryRefusal(m.user_id!, rules.category, pair)
          : m.gender === null
            ? teamRefusal("TM_MEMBER_GENDER", { name })
            : categoryRefusalFor(m.gender, rules.category, pair);
      if (refusal) {
        // Not said (their account's, or what a guardian declared): asked for. Said, and not this event's: does not fit.
        if (refusal.code === "TM_MEMBER_GENDER") return refusal as TeamRefusal;
        if (refusal.code === "GENDER_NEEDED") return teamRefusal("TM_MEMBER_GENDER", { name });
        return teamRefusal(rules.category === "women" ? "TM_MEMBER_WOMEN" : "TM_MEMBER_MEN", { name });
      }
    }
    const entrant =
      m.participant_id === null
        ? ({ kind: "self", userId: m.user_id!, name } as const)
        : ({ kind: "participant", userId: m.acting_user_id ?? 0, guardianName: "", participantId: m.participant_id, name } as const);
    if (rules.membersOnly && !(await entrantMembership(rules.venueId, entrant, today))) return teamRefusal("TM_MEMBER_MEMBERS_ONLY", { name });
    const notHere = await entrantVenueRefusal(rules.venueId, entrant, today);
    if (notHere) return teamRefusal("TM_MEMBER_VENUE", { name });
    picked.push({ memberId: m.id, name, declaredMinor: minor, guardianAgreedAt: minor || m.participant_id !== null ? m.agreed_at : null, userId: m.user_id });
  }
  return { ok: true, value: picked };
}

/** Is the team this account's to enter in an event: its captain's, active, and playing the event's sport? */
export async function teamForEntry(userId: number, teamId: unknown, sport: string): Promise<TeamResult<{ id: number; name: string }>> {
  const id = Number(teamId);
  const team = Number.isInteger(id) ? await teamRow(id) : null;
  if (!team || !(await myMembers(id, userId)).length) return notFound();
  if (team.captainUserId !== userId) return teamRefusal("TM_ENTRY_CAPTAIN", {}, 403);
  if (team.status !== "active") return teamRefusal("TM_ARCHIVED");
  if (team.sport !== sport) return teamRefusal("TM_ENTRY_SPORT", { team: team.name, sport: team.sport });
  return { ok: true, value: { id: team.id, name: team.name } };
}

/** Everybody on a roster told they are on it (a child's guardian, naming the child): they hear it here, not from the captain alone. */
export async function tellRoster(memberIds: number[], event: string, venueId: number, link: string, what: "tournament" | "league"): Promise<void> {
  for (const id of memberIds) {
    const m = await memberRow(id);
    if (!m) continue;
    await tellMember(
      m,
      venueId,
      (tr) => tr(what === "league" ? "tm.mail.rostered.league.s" : "tm.mail.rostered.s", { event }),
      (tr) => tr(what === "league" ? "tm.mail.rostered.league.b" : "tm.mail.rostered.b", { event }),
      link
    );
  }
}

/** Tell the account behind a member something about an event, in their language (a child's guardian, naming the child). */
export async function tellMemberById(memberId: number, venueId: number | null, subject: Written, body: Written, link: string): Promise<void> {
  const m = await memberRow(memberId);
  if (m) await tellMember(m, venueId, subject, body, link);
}

// ------------------------------------------------------------ history

export interface TeamHistory {
  tournaments: { entryId: number; tournament: string; tournamentId: number; venue: string; startsOn: string; entryStatus: string; tournamentStatus: string; results: { opponent: string; score: string | null; won: boolean | null; round: number | null; stage: string }[] }[];
  leagues: { leagueId: number; league: string; venue: string; status: string; fixtures: { fixtureId: number; date: string; opponent: string; home: boolean; status: string; score: string | null; won: boolean | null }[] }[];
}

/**
 * What a team has entered and how it went, for its members (a child's guardian
 * included): tournaments entered and each match's result, and league fixtures
 * with theirs. Nothing about who else was in it but the opposing teams' names.
 */
export async function teamHistory(userId: number, teamId: number): Promise<TeamResult<TeamHistory>> {
  if (!(await myMembers(teamId, userId)).length) return notFound();
  const db = getDb();
  const entries = (await db
    .prepare(
      `SELECT e.id AS entry_id, e.status AS entry_status, t.id AS tournament_id, t.name AS tournament, t.starts_on, t.status AS tournament_status, v.name AS venue
         FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id JOIN venues v ON v.id = t.venue_id
        WHERE e.team_id = ? ORDER BY t.starts_on DESC, e.id DESC`
    )
    .all(teamId)) as { entry_id: number; entry_status: string; tournament_id: number; tournament: string; starts_on: string; tournament_status: string; venue: string }[];
  const tournaments: TeamHistory["tournaments"] = [];
  for (const e of entries) {
    const matches = (await db
      .prepare(
        `SELECT m.entry_a, m.entry_b, m.winner, m.score, m.round, m.stage, a.name AS name_a, b.name AS name_b
           FROM tournament_matches m LEFT JOIN tournament_entries a ON a.id = m.entry_a LEFT JOIN tournament_entries b ON b.id = m.entry_b
          WHERE m.tournament_id = ? AND (m.entry_a = ? OR m.entry_b = ?) AND m.status IN ('played', 'walkover', 'retired') ORDER BY m.id`
      )
      .all(e.tournament_id, e.entry_id, e.entry_id)) as { entry_a: number | null; entry_b: number | null; winner: number | null; score: string | null; round: number | null; stage: string; name_a: string | null; name_b: string | null }[];
    tournaments.push({
      entryId: e.entry_id,
      tournament: e.tournament,
      tournamentId: e.tournament_id,
      venue: e.venue,
      startsOn: e.starts_on,
      entryStatus: e.entry_status,
      tournamentStatus: e.tournament_status,
      results: matches.map((m) => ({
        opponent: (m.entry_a === e.entry_id ? m.name_b : m.name_a) ?? "",
        score: m.score,
        won: m.winner === null ? null : m.winner === e.entry_id,
        round: m.round,
        stage: m.stage,
      })),
    });
  }
  const { teamLeagueHistory } = await import("./team-leagues");
  return { ok: true, value: { tournaments, leagues: await teamLeagueHistory(teamId) } };
}

// ------------------------------------------------------------ their own data

/** What the data export holds of an account's teams: its places on them, and the children it acts for. Nothing about others on the team. */
export async function teamsExport(userId: number): Promise<unknown[]> {
  return (await getDb()
    .prepare(
      `SELECT t.name AS team, t.sport, m.role, m.status, m.joined_at, m.left_at, m.birth_date AS declared_birth_date, m.gender AS declared_gender,
              CASE WHEN m.participant_id IS NULL THEN NULL ELSE p.display_name END AS on_behalf_of, m.agreed_at AS guardian_agreed_at
         FROM team_members m JOIN teams t ON t.id = m.team_id LEFT JOIN participants p ON p.id = m.participant_id
        WHERE m.user_id = ? OR m.acting_user_id = ? ORDER BY m.id`
    )
    .all(userId, userId)) as unknown[];
}

/** What a participant's own record holds of teams, for their export. */
export async function participantTeamsExport(participantId: number): Promise<unknown[]> {
  return (await getDb()
    .prepare(
      `SELECT t.name AS team, t.sport, m.status, m.joined_at, m.left_at, m.birth_date AS declared_birth_date, m.gender AS declared_gender, m.agreed_at AS guardian_agreed_at
         FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.participant_id = ? ORDER BY m.id`
    )
    .all(participantId)) as unknown[];
}

/**
 * Names kept as history on event rosters (a tournament's roster of names, a league's roster and lineups) for these members become
 * `anonymous`: what they played stays, who they were does not.
 */
async function anonymiseHistory(memberIds: number[], anonymous: string): Promise<void> {
  const db = getDb();
  for (const id of memberIds) {
    const entries = (await db.prepare("SELECT DISTINCT entry_id FROM tournament_entry_members WHERE team_member_id = ?").all(id)) as { entry_id: number }[];
    await db.prepare("UPDATE tournament_entry_members SET name = ? WHERE team_member_id = ?").run(anonymous, id);
    for (const e of entries) {
      const names = (await db.prepare("SELECT name FROM tournament_entry_members WHERE entry_id = ? ORDER BY id").all(e.entry_id)) as { name: string }[];
      await db.prepare("UPDATE tournament_entries SET roster = ? WHERE id = ?").run(JSON.stringify(names.map((n) => n.name)), e.entry_id);
    }
    await db.prepare("UPDATE team_league_roster SET name = ? WHERE team_member_id = ?").run(anonymous, id);
    await db.prepare("UPDATE team_fixture_lineups SET name = ? WHERE team_member_id = ?").run(anonymous, id);
  }
}

/**
 * An account erased: off every team, and the captaincy handed to the longest-standing member who has an account of their own and has said
 * they are an adult, else the team archived and withdrawn from what it is entered in; invitations they sent are cancelled; the children
 * they act for come off (only the guardian could have put them on). What they played stays in the events' records, their name anonymised.
 */
export async function forgetTeamsOfUser(userId: number, anonymous: string): Promise<void> {
  const db = getDb();
  const live = (await db.prepare("SELECT id, team_id, role FROM team_members WHERE (user_id = ? OR acting_user_id = ?) AND status = 'member'").all(userId, userId)) as {
    id: number;
    team_id: number;
    role: MemberRole;
  }[];
  for (const m of live) {
    if (m.role === "captain") {
      const next = (await db
        .prepare(
          `SELECT m.id, m.user_id FROM team_members m JOIN player_profiles p ON p.user_id = m.user_id
            WHERE m.team_id = ? AND m.status = 'member' AND m.user_id IS NOT NULL AND m.user_id <> ? AND p.adult = 1 ORDER BY m.joined_at, m.id LIMIT 1`
        )
        .get(m.team_id, userId)) as { id: number; user_id: number } | undefined;
      await db.prepare("UPDATE team_members SET role = 'member' WHERE id = ?").run(m.id);
      if (next) {
        await db.prepare("UPDATE team_members SET role = 'captain' WHERE id = ?").run(next.id);
        await db.prepare("UPDATE teams SET captain_user_id = ? WHERE id = ?").run(next.user_id, m.team_id);
      } else {
        // Nobody to hand it to: withdrawn from what it is entered in, then archived.
        await db.prepare("UPDATE teams SET captain_user_id = NULL, status = 'archived', archived_at = datetime('now'), published = false WHERE id = ?").run(m.team_id);
        const { withdrawTeamFromEvents } = await import("./team-leagues");
        await withdrawTeamFromEvents(m.team_id);
      }
    }
    await dropFromRosters(m.id, "left");
  }
  const all = (await db.prepare("SELECT id FROM team_members WHERE user_id = ? OR acting_user_id = ?").all(userId, userId)) as { id: number }[];
  await anonymiseHistory(
    all.map((r) => r.id),
    anonymous
  );
  await db.prepare("DELETE FROM team_members WHERE user_id = ? OR acting_user_id = ?").run(userId, userId);
  await db.prepare("UPDATE team_invitations SET cancelled_at = COALESCE(cancelled_at, datetime('now')) WHERE invited_by = ? AND used_at IS NULL").run(userId);
}

/** A participant's record erased: off every team and the event rosters not yet played; the names the history kept are anonymised. */
export async function forgetTeamsOfParticipant(participantId: number, anonymous: string): Promise<void> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id, status FROM team_members WHERE participant_id = ?").all(participantId)) as { id: number; status: string }[];
  for (const r of rows) if (r.status === "member") await dropFromRosters(r.id, "left");
  await anonymiseHistory(
    rows.map((r) => r.id),
    anonymous
  );
  await db.prepare("DELETE FROM team_members WHERE participant_id = ?").run(participantId);
}

/**
 * Retention: left and removed members are forgotten after a year (what they played stays in the events' own records, by the name it
 * carried), and invitations long past their time are deleted. Returns how many of each.
 */
export async function teamHousekeeping(): Promise<{ members: number; invitations: number }> {
  const db = getDb();
  const done = await db.prepare(`DELETE FROM team_members WHERE status <> 'member' AND left_at < datetime('now', '-${LEFT_MEMBER_KEEP_DAYS} days')`).run();
  const inv = await db.prepare("DELETE FROM team_invitations WHERE expires_at < datetime('now', '-2 days')").run();
  return { members: done.changes, invitations: inv.changes };
}

export type { Vars };
