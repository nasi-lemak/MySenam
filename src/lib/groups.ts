import { getDb, withTransaction } from "./db";
import { baseUrl, drainOutbox, emailPlayer } from "./outbox";
import { blockedBetween, related } from "./player-safety";
import { declaredAdult } from "./player-profiles";
import { gameById, invitePlayer, invitesToday, INVITES_PER_DAY } from "./games";
import {
  claimInvitation,
  GROUP_INVITE_DAYS,
  invitationAddress,
  invitationInvalid,
  invitationNotFound,
  issueInvitation,
  newInvitationToken,
  openEmailInvitations,
  withdrawPlayerInvitation,
  type EmailInvitation,
  type InvitationRow,
  type PlayerAcceptResult,
  type WithdrawResult,
} from "./player-invitations";
import type { Sport } from "./types";

/**
 * Community groups: a doubles four, a futsal side, a Wednesday crowd — people
 * who play together again and again, organised by one of them.
 *
 * A group is not a tournament entry and not a booking: it holds no court and
 * no money. What it does is let its organiser (or any member who hosts a
 * game) invite the group to a game in one go, through the ordinary
 * invitations (lib/games.ts), each member still saying yes or no.
 *
 * Membership is always agreed by both sides: somebody asks and the organiser
 * says yes, or the organiser invites and they say yes. Nobody joins a group
 * by themselves, because being in a group with somebody is what lets them
 * invite you to games — and the only way a player under 18 can be invited at
 * all — so a group must not be a door anybody can walk through. A public
 * group is listed for people to ask to join; a private one is seen only by
 * its members and those invited. Members see each other's first names;
 * nobody sees anybody's contact details.
 */

export const GROUPS_PER_ORGANISER = 5;
export type GroupPrivacy = "public" | "private";
export type MemberStatus = "invited" | "requested" | "member" | "left" | "removed" | "declined";

export interface Group {
  id: number;
  name: string;
  sport: Sport;
  area: string | null;
  description: string | null;
  privacy: GroupPrivacy;
  capacity: number;
  members: number;
  organiserId: number;
  organiserName: string;
  status: "active" | "closed";
  /** For whoever is asking. */
  mine?: { memberId: number; role: "organiser" | "member"; status: MemberStatus } | null;
  /** Members (first names), for members only; and for the organiser, everybody waiting. */
  roster?: { memberId: number; userId: number; name: string; role: "organiser" | "member"; status: MemberStatus }[];
  /** For the organiser: invitations by email not yet accepted, shown as "invited (email)", never who. */
  emailInvites?: EmailInvitation[];
}

interface GroupRow {
  id: number;
  name: string;
  sport: Sport;
  area: string | null;
  description: string | null;
  privacy: GroupPrivacy;
  capacity: number;
  members: number;
  organiser_id: number;
  organiser_name: string;
  status: "active" | "closed";
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const GROUP_SELECT = `
  SELECT g.id, g.name, g.sport, g.area, g.description, g.privacy, g.capacity, g.organiser_id, g.status, u.name AS organiser_name,
         (SELECT COUNT(*)::int FROM group_members m WHERE m.group_id = g.id AND m.status = 'member') AS members
    FROM community_groups g JOIN users u ON u.id = g.organiser_id`;

function toGroup(r: GroupRow): Group {
  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    area: r.area,
    description: r.description,
    privacy: r.privacy,
    capacity: r.capacity,
    members: r.members,
    organiserId: r.organiser_id,
    organiserName: firstName(r.organiser_name),
    status: r.status,
  };
}

async function groupRow(id: number): Promise<Group | null> {
  const row = (await getDb().prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id)) as GroupRow | undefined;
  return row ? toGroup(row) : null;
}

async function membership(groupId: number, userId: number) {
  return (await getDb().prepare("SELECT id, role, status FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId)) as
    | { id: number; role: "organiser" | "member"; status: MemberStatus }
    | undefined;
}

export type GroupResult = { ok: true; group: Group } | { ok: false; error: string; status?: number; code?: string };

export async function createGroup(
  organiserId: number,
  input: { name: unknown; sport: unknown; area?: unknown; description?: unknown; privacy?: unknown; capacity?: unknown }
): Promise<GroupResult> {
  const { isActivity } = await import("./activities");
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  if (name.length < 3) return { ok: false, error: "Give the group a name." };
  if (!(await isActivity(input.sport))) return { ok: false, error: "Unknown sport." };
  const privacy = input.privacy === "private" ? "private" : "public";
  const capacity = input.capacity === undefined ? 20 : Number(input.capacity);
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 60) return { ok: false, error: "A group holds 2 to 60 people." };
  const db = getDb();
  const mine = (await db.prepare("SELECT COUNT(*)::int AS n FROM community_groups WHERE organiser_id = ? AND status = 'active'").get(organiserId)) as { n: number };
  if (mine.n >= GROUPS_PER_ORGANISER) return { ok: false, error: `You can run ${GROUPS_PER_ORGANISER} groups at a time.` };
  const id = await withTransaction(async () => {
    const made = await db
      .prepare("INSERT INTO community_groups (name, sport, area, description, organiser_id, privacy, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        name,
        input.sport,
        typeof input.area === "string" ? input.area.trim().slice(0, 80) || null : null,
        typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null,
        organiserId,
        privacy,
        capacity
      );
    await db.prepare("INSERT INTO group_members (group_id, user_id, role, status) VALUES (?, ?, 'organiser', 'member')").run(made.lastInsertRowid, organiserId);
    return made.lastInsertRowid!;
  });
  return { ok: true, group: (await groupView(id, organiserId))! };
}

/** Public groups to ask to join, by sport and area, a page at a time; and, signed in, your own. */
export async function listGroups(filter: { sport?: Sport; area?: string; viewerId?: number; limit?: number; offset?: number } = {}): Promise<Group[]> {
  const clauses = ["g.status = 'active'"];
  const params: (string | number)[] = [];
  if (filter.viewerId !== undefined) {
    clauses.push("(g.privacy = 'public' OR g.id IN (SELECT group_id FROM group_members WHERE user_id = ? AND status IN ('member', 'invited')))");
    params.push(filter.viewerId);
  } else clauses.push("g.privacy = 'public'");
  if (filter.sport) {
    clauses.push("g.sport = ?");
    params.push(filter.sport);
  }
  if (filter.area) {
    clauses.push("LOWER(g.area) = LOWER(?)");
    params.push(filter.area);
  }
  const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
  const rows = (await getDb()
    .prepare(`${GROUP_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY g.id DESC LIMIT ${limit} OFFSET ${Math.max(0, filter.offset ?? 0)}`)
    .all(...params)) as GroupRow[];
  const groups = rows.map(toGroup);
  if (filter.viewerId !== undefined)
    for (const g of groups) {
      const m = await membership(g.id, filter.viewerId);
      g.mine = m ? { memberId: m.id, role: m.role, status: m.status } : null;
    }
  return groups;
}

/**
 * One group as this person may see it: a public one to anybody, a private one
 * to its members and those invited. Members see the roster of members; the
 * organiser also sees who is asking or invited.
 */
export async function groupView(groupId: number, viewerId: number | null): Promise<Group | null> {
  const group = await groupRow(groupId);
  if (!group) return null;
  const m = viewerId === null ? undefined : await membership(groupId, viewerId);
  if (group.privacy === "private" && !(m && (m.status === "member" || m.status === "invited"))) return null;
  group.mine = m ? { memberId: m.id, role: m.role, status: m.status } : null;
  if (m?.status === "member") {
    const organiser = m.role === "organiser";
    const rows = (await getDb()
      .prepare(
        `SELECT m.id, m.user_id, u.name, m.role, m.status FROM group_members m JOIN users u ON u.id = m.user_id
          WHERE m.group_id = ? AND m.status IN (${organiser ? "'member', 'requested', 'invited'" : "'member'"}) ORDER BY m.role DESC, m.id`
      )
      .all(groupId)) as { id: number; user_id: number; name: string; role: "organiser" | "member"; status: MemberStatus }[];
    group.roster = rows.map((r) => ({ memberId: r.id, userId: r.user_id, name: firstName(r.name), role: r.role, status: r.status }));
    if (organiser) group.emailInvites = await openEmailInvitations({ groupId });
  }
  return group;
}

/** Somebody asking to join a public group, or a private one they were invited to (which is saying yes). */
export async function joinGroup(userId: number, groupId: number): Promise<GroupResult> {
  const group = await groupRow(groupId);
  if (!group || group.status !== "active") return { ok: false, error: "That group is not there any more.", status: 404 };
  const m = await membership(groupId, userId);
  if (group.privacy === "private" && m?.status !== "invited") return { ok: false, error: "That group is not there any more.", status: 404 };
  if (await blockedBetween(userId, group.organiserId)) return { ok: false, error: "That group is not taking members." };
  const refused = await withTransaction(async (): Promise<string | null> => {
    const db = getDb();
    await db.prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(groupId);
    const now = await membership(groupId, userId);
    if (now?.status === "member") return "You are in this group already.";
    if (now?.status === "requested") return "You have asked already.";
    if (now?.status === "removed" || now?.status === "declined") return "The organiser has said no.";
    const count = (await db.prepare("SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = ? AND status = 'member'").get(groupId)) as { n: number };
    // An invitation taken up is both sides agreeing; anything else waits for the organiser.
    const status: MemberStatus = now?.status === "invited" ? "member" : "requested";
    if (status === "member" && count.n >= group.capacity) return "That group is full.";
    if (now) await db.prepare("UPDATE group_members SET status = ? WHERE id = ?").run(status, now.id);
    else await db.prepare("INSERT INTO group_members (group_id, user_id, status) VALUES (?, ?, ?)").run(groupId, userId, status);
    if (status === "requested")
      await emailPlayer({
        venueId: null,
        userId: group.organiserId,
        subject: (tr) => tr("mail.group.request.s", { g: group.name }),
        body: (tr) => tr("mail.group.request.b", { g: group.name }),
        link: `${baseUrl()}/games/groups/${groupId}`,
      });
    return null;
  });
  if (refused) return { ok: false, error: refused };
  return { ok: true, group: (await groupView(groupId, userId))! };
}

export async function leaveGroup(userId: number, groupId: number): Promise<GroupResult> {
  const m = await membership(groupId, userId);
  if (!m || !["member", "requested", "invited"].includes(m.status)) return { ok: false, error: "You are not in that group.", status: 404 };
  if (m.role === "organiser") return { ok: false, error: "An organiser closes the group rather than leaving it." };
  await getDb().prepare("UPDATE group_members SET status = ? WHERE id = ?").run(m.status === "invited" ? "declined" : "left", m.id);
  return { ok: true, group: (await groupRow(groupId))! };
}

/** The organiser on one person: let them in, turn them down, or take them out. */
export async function decideMember(organiserId: number, memberId: number, action: "accept" | "decline" | "remove"): Promise<GroupResult> {
  const db = getDb();
  const row = (await db
    .prepare("SELECT m.id, m.group_id, m.user_id, m.status, m.role, g.organiser_id, g.capacity, g.name FROM group_members m JOIN community_groups g ON g.id = m.group_id WHERE m.id = ?")
    .get(memberId)) as
    | { id: number; group_id: number; user_id: number; status: MemberStatus; role: string; organiser_id: number; capacity: number; name: string }
    | undefined;
  if (!row || row.organiser_id !== organiserId) return { ok: false, error: "Not found.", status: 404 };
  if (row.role === "organiser") return { ok: false, error: "That is you." };
  const refused = await withTransaction(async (): Promise<string | null> => {
    await db.prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(row.group_id);
    const now = (await db.prepare("SELECT status FROM group_members WHERE id = ?").get(memberId)) as { status: MemberStatus };
    if (action === "accept") {
      if (now.status !== "requested") return "They are not waiting for an answer.";
      const count = (await db.prepare("SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = ? AND status = 'member'").get(row.group_id)) as { n: number };
      if (count.n >= row.capacity) return "The group is full.";
      await db.prepare("UPDATE group_members SET status = 'member' WHERE id = ?").run(memberId);
      await emailPlayer({
        venueId: null,
        userId: row.user_id,
        subject: (tr) => tr("mail.group.accepted.s", { g: row.name }),
        body: (tr) => tr("mail.group.accepted.b", { g: row.name }),
        link: `${baseUrl()}/games/groups/${row.group_id}`,
      });
    } else if (action === "decline") {
      if (now.status !== "requested") return "They are not waiting for an answer.";
      await db.prepare("UPDATE group_members SET status = 'declined' WHERE id = ?").run(memberId);
    } else {
      if (!["member", "invited", "requested"].includes(now.status)) return "They are not in the group.";
      await db.prepare("UPDATE group_members SET status = 'removed' WHERE id = ?").run(memberId);
    }
    return null;
  });
  if (refused) return { ok: false, error: refused };
  return { ok: true, group: (await groupView(row.group_id, organiserId))! };
}

/**
 * The organiser inviting somebody by email. The address is never looked up:
 * whether or not an account holds it, and whether or not whoever does may be
 * invited, the answer and the work done are the same. The invitation counts
 * against the daily limit and the address is emailed a single-use link
 * (lib/player-invitations.ts), for GROUP_INVITE_DAYS. The organiser sees
 * "invited (email)" until the account that signs in with that address
 * accepts it, which makes them a member if the rules allow
 * (acceptGroupInvitation).
 */
export async function inviteToGroup(organiserId: number, groupId: number, email: string): Promise<GroupResult> {
  const group = await groupRow(groupId);
  if (!group || group.organiserId !== organiserId || group.status !== "active") return { ok: false, error: "Not found.", status: 404 };
  const address = await invitationAddress(organiserId, email);
  if (!address.ok) return { ok: false, error: address.error, code: address.code, status: 400 };
  if ((await invitesToday(organiserId)) >= INVITES_PER_DAY) return { ok: false, error: "You have sent a lot of invitations today. Please try again tomorrow.", status: 429 };
  const token = newInvitationToken();
  const organiser = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(organiserId)) as { name: string };
  await withTransaction(async () => {
    await getDb().prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(groupId);
    await issueInvitation({
      target: { groupId },
      invitedBy: organiserId,
      email: address.email,
      token,
      expiresAt: ((await getDb().prepare(`SELECT datetime('now', '+${GROUP_INVITE_DAYS} days') AS at`).get()) as { at: string }).at,
      subject: "gi7.mail.group.s",
      body: "gi7.mail.group.b",
      vars: { by: firstName(organiser.name), g: group.name, days: GROUP_INVITE_DAYS, link: `${baseUrl()}/player-invitation?token=${token}` },
    });
  });
  // As a password reset's link: sent now if it can be, not waited on, and the same either way.
  void drainOutbox().catch(() => null);
  return { ok: true, group: (await groupView(groupId, organiserId))! };
}

/**
 * The organiser withdrawing an invitation by email not yet accepted
 * (withdrawPlayerInvitation), under the group's row lock, as accepting it
 * is. Anybody else, or an invitation to another group, hears it is not
 * found, as if there were none.
 */
export async function withdrawGroupInvitation(organiserId: number, groupId: number, invitationId: unknown): Promise<WithdrawResult> {
  if (!Number.isInteger(invitationId)) return invitationNotFound();
  const group = await groupRow(groupId);
  if (!group || group.organiserId !== organiserId) return invitationNotFound();
  return withdrawPlayerInvitation({
    id: invitationId as number,
    target: { groupId },
    by: organiserId,
    lock: () => getDb().prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(groupId),
    notice: { subject: "rv7.mail.group.s", body: "rv7.mail.group.b", vars: { g: group.name } },
  });
}

/**
 * Accept an emailed invitation to a group, signed in with the address it was
 * sent to: both sides agreeing, so they are a member, if there is room. Only
 * a declared adult the organiser has come across here, or who has opted in
 * to being invited, and nobody across a block, can be: anybody else's is
 * refused in the same words as an invitation that does not exist. A player
 * under 18 asks to join a group themselves, never invited into one out of
 * the blue.
 */
export async function acceptGroupInvitation(user: { id: number }, invitation: InvitationRow): Promise<PlayerAcceptResult> {
  const groupId = invitation.groupId!;
  const group = await groupRow(groupId);
  if (!group || group.status !== "active" || group.organiserId !== invitation.invitedBy || user.id === group.organiserId) return invitationInvalid();
  if (!(await mayJoinByInvitation(group.organiserId, user.id))) return invitationInvalid();
  const db = getDb();
  const refused = await withTransaction(async (): Promise<PlayerAcceptResult | null> => {
    await db.prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(groupId);
    const now = await membership(groupId, user.id);
    // Somebody the organiser took out is not let back in by an email.
    if (now?.status === "removed") return invitationInvalid();
    if (now?.status !== "member") {
      const count = (await db.prepare("SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = ? AND status = 'member'").get(groupId)) as { n: number };
      // Not spent on a refusal: kept for when somebody leaves, while it lasts.
      if (count.n >= group.capacity) return { ok: false, error: "That group is full.", status: 409 };
    }
    if (!(await claimInvitation(invitation.id, user.id))) return invitationInvalid();
    if (now?.status === "member") return null;
    if (now) await db.prepare("UPDATE group_members SET status = 'member', invited_by = ? WHERE id = ?").run(group.organiserId, now.id);
    else await db.prepare("INSERT INTO group_members (group_id, user_id, status, invited_by) VALUES (?, ?, 'member', ?)").run(groupId, user.id, group.organiserId);
    return null;
  });
  if (refused) return refused;
  return { ok: true, kind: "group", groupId, name: group.name };
}

async function mayJoinByInvitation(organiserId: number, userId: number): Promise<boolean> {
  if ((await declaredAdult(userId)) !== true || (await blockedBetween(organiserId, userId))) return false;
  const opted = (await getDb().prepare("SELECT 1 FROM player_profiles WHERE user_id = ? AND (invitable = 1 OR discoverable = 1)").get(userId)) as unknown;
  return Boolean(opted) || (await related(organiserId, userId));
}

/**
 * A member who hosts a game inviting the rest of the group to it, through the
 * ordinary invitations: each member is invited only if they may be (blocks,
 * the game's own rules, the daily limit), and says yes or no themselves.
 */
export async function inviteGroupToGame(hostId: number, groupId: number, gameId: number): Promise<{ ok: true; invited: number } | { ok: false; error: string; status?: number }> {
  const m = await membership(groupId, hostId);
  if (m?.status !== "member") return { ok: false, error: "Not found.", status: 404 };
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId) return { ok: false, error: "Not found.", status: 404 };
  const members = (await getDb()
    .prepare("SELECT user_id FROM group_members WHERE group_id = ? AND status = 'member' AND user_id <> ? ORDER BY id")
    .all(groupId, hostId)) as { user_id: number }[];
  let invited = 0;
  for (const member of members) {
    const sent = await invitePlayer(hostId, gameId, member.user_id);
    if (sent.ok) invited++;
    else if (sent.status === 429) break;
  }
  return { ok: true, invited };
}

/** The organiser closing the group: it stops being listed, and nobody joins. Games already arranged are unaffected. */
export async function closeGroup(organiserId: number, groupId: number): Promise<GroupResult> {
  const done = await getDb().prepare("UPDATE community_groups SET status = 'closed' WHERE id = ? AND organiser_id = ? AND status = 'active'").run(groupId, organiserId);
  if (done.changes === 0) return { ok: false, error: "Not found.", status: 404 };
  return { ok: true, group: (await groupRow(groupId))! };
}
