import { getDb } from "./db";
import { logAction } from "./activity";
import type { Admin } from "./admin-auth";
import { answerVenueRequest, endYouthGroup, guardianChild, refuseYouth, youthEvent, youthGroupOf, type DeclaredRole, type YouthRefusal } from "./youth-messages";
import type { SeatLabel } from "./message-contexts";
import { inScope, scopeOf } from "./message-moderation";
import { VISIBLE } from "./messages";
import { baseUrl, emailPlayer } from "./outbox";
import { siteName } from "./site";
import { staffSentences, tellOwnersEach, tellVenueStaffEach } from "./owner-alerts";
import { shortName } from "./public-names";

/**
 * The safeguarding side of supervised youth groups (docs/features/player-messages.md#supervised-youth-groups; ADR 0044): the urgent notices
 * (immediate, never digested, not held to the daily limit, never the text of a message), what a guardian may read of their child's group
 * thread, what the staff of the group's venue may read (each view audited), and what a guardian may export.
 *
 * **A deliberate exception to "nobody on staff reads an ordinary message"** (ADR 0039): staff of a group's venue may read the thread of a
 * supervised youth group that has asked that venue and that the venue's manager accepted (the platform owner, for one with no venue), for
 * moderation and safeguarding review, and only that. Managers only (front desk is turned away), each view recorded in the staff activity log
 * and in the group's own record, and the first-use screen tells members a supervisor can read the group's messages. An adults' ordinary
 * thread is as unreadable as it was.
 */

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
const parseLabel = (raw: string | null): SeatLabel | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SeatLabel;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

/** The live guardians (with an account) of the participant whose own login is this account. */
async function guardiansOfMinor(minorId: number): Promise<{ userId: number; child: string }[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT g.user_id, pt.display_name FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id
        WHERE pt.linked_user_id = ? AND g.user_id IS NOT NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL`
    )
    .all(minorId)) as { user_id: number; display_name: string }[];
  return rows.map((r) => ({ userId: r.user_id, child: r.display_name }));
}

async function isMinorAccount(userId: number | null): Promise<boolean> {
  if (userId === null) return false;
  return !(await getDb().prepare("SELECT 1 FROM player_profiles WHERE user_id = ? AND adult = 1").get(userId));
}

// ------------------------------------------------------------------ urgent notices

/**
 * A report in a youth group's thread: told at once (kind `safeguarding_notice`, email, never the text) to the supervisors (not the person
 * reported, if one), the live guardians of a minor who reported or was reported, and the staff of the group's venue (managers), or the
 * platform's owners where it has none. Each notice is queued once per recipient and report.
 */
export async function tellUrgentReport(reportId: number): Promise<void> {
  const db = getDb();
  const r = (await db
    .prepare("SELECT id, context_id, venue_id, reporter_id, reported_id FROM player_message_reports WHERE id = ? AND urgent = 1")
    .get(reportId)) as { id: number; context_id: number; venue_id: number | null; reporter_id: number | null; reported_id: number | null } | undefined;
  if (!r) return;
  const group = (await db.prepare("SELECT name FROM community_groups WHERE id = ?").get(r.context_id)) as { name: string } | undefined;
  if (!group) return;
  const link = `${baseUrl()}/messages?open=group:${r.context_id}`;
  const told = new Set<number>();
  const tell = async (userId: number, key: "pmy.mail.report.supervisor" | "pmy.mail.report.guardianAbout" | "pmy.mail.report.guardianBy", vars: Record<string, string>) => {
    if (told.has(userId)) return;
    told.add(userId);
    await emailPlayer({
      kind: "safeguarding_notice",
      venueId: null,
      userId,
      subject: (t) => t("pmy.mail.subject", { site: siteName() }),
      body: (t) => t(key, { ...vars, group: group.name, who: r.venue_id === null ? t("pmy.mail.whoOwner") : t("pmy.mail.whoVenue") }),
      link,
      dedupeKey: `pmy:report:${reportId}:${userId}`,
    });
  };
  const supervisors = (await db
    .prepare(
      `SELECT a.user_id FROM youth_group_adults a JOIN group_members m ON m.group_id = a.group_id AND m.user_id = a.user_id AND m.status = 'member'
        WHERE a.group_id = ? AND a.role = 'supervisor' AND a.removed_at IS NULL`
    )
    .all(r.context_id)) as { user_id: number }[];
  for (const s of supervisors) if (s.user_id !== r.reported_id) await tell(s.user_id, "pmy.mail.report.supervisor", {});
  if (r.reported_id !== null && (await isMinorAccount(r.reported_id)))
    for (const g of await guardiansOfMinor(r.reported_id)) await tell(g.userId, "pmy.mail.report.guardianAbout", { child: g.child });
  if (r.reporter_id !== null && (await isMinorAccount(r.reporter_id)))
    for (const g of await guardiansOfMinor(r.reporter_id)) await tell(g.userId, "pmy.mail.report.guardianBy", { child: g.child });
  const write = (t: Parameters<Parameters<typeof tellOwnersEach>[0]>[0]) => ({
    subject: t("ysg.mail.reportSubject", { group: group.name }),
    body: staffSentences(t, t("ysg.mail.reportBody", { group: group.name, id: reportId })),
  });
  if (r.venue_id === null) await tellOwnersEach(write);
  else await tellVenueStaffEach(r.venue_id, write, { managersOnly: true });
}

/** The conversation of a youth group has been closed (by a supervisor or by staff): its supervisors and the guardians of the minors in it are told at once. */
export async function tellThreadClosed(groupId: number): Promise<void> {
  const db = getDb();
  const group = (await db.prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
  if (!group) return;
  const minors = (await db
    .prepare(
      `SELECT m.user_id FROM group_members m WHERE m.group_id = ? AND m.status = 'member'
          AND NOT EXISTS (SELECT 1 FROM player_profiles p WHERE p.user_id = m.user_id AND p.adult = 1)`
    )
    .all(groupId)) as { user_id: number }[];
  const to = new Map<number, string>();
  for (const m of minors) for (const g of await guardiansOfMinor(m.user_id)) to.set(g.userId, g.child);
  const adults = (await db.prepare("SELECT user_id FROM youth_group_adults WHERE group_id = ? AND removed_at IS NULL").all(groupId)) as { user_id: number }[];
  for (const a of adults) if (!to.has(a.user_id)) to.set(a.user_id, "");
  for (const [userId, child] of to)
    await emailPlayer({
      kind: "safeguarding_notice",
      venueId: null,
      userId,
      subject: (t) => t("pmy.mail.subject", { site: siteName() }),
      body: (t) => t(child ? "pmy.mail.closedGuardian" : "pmy.mail.closed", { group: group.name, child }),
      link: `${baseUrl()}/messages?open=group:${groupId}`,
      dedupeKey: `pmy:closed:${groupId}:${userId}:${Math.floor(Date.now() / 3_600_000)}`,
    });
}

/** Somebody's messaging was paused (by staff or automatically): they are told at once, and their guardians if they are a minor. Never why in detail. */
export async function tellSuspended(userId: number): Promise<void> {
  const to = new Map<number, string>([[userId, ""]]);
  if (await isMinorAccount(userId)) for (const g of await guardiansOfMinor(userId)) to.set(g.userId, g.child);
  for (const [uid, child] of to)
    await emailPlayer({
      kind: "safeguarding_notice",
      venueId: null,
      userId: uid,
      subject: (t) => t("pmy.mail.subject", { site: siteName() }),
      body: (t) => t(child ? "pmy.mail.suspendedGuardian" : "pmy.mail.suspended", { child }),
      link: `${baseUrl()}/messages`,
      dedupeKey: `pmy:suspended:${userId}:${uid}:${Math.floor(Date.now() / 3_600_000)}`,
    });
}

/**
 * A supervisor muted a minor in the conversation, or removed one of their messages: the child's guardians are told at once (a moderation
 * notice: the child's report and moderation notices are the guardian's to receive), never what was written.
 */
export async function tellGuardiansModerated(minorId: number, groupId: number, what: "muted" | "removed"): Promise<void> {
  if (!(await isMinorAccount(minorId))) return;
  const group = (await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
  if (!group) return;
  for (const g of await guardiansOfMinor(minorId))
    await emailPlayer({
      kind: "safeguarding_notice",
      venueId: null,
      userId: g.userId,
      subject: (t) => t("pmy.mail.subject", { site: siteName() }),
      body: (t) => t(what === "muted" ? "pmy.mail.mutedGuardian" : "pmy.mail.removedGuardian", { group: group.name, child: g.child }),
      link: `${baseUrl()}/account`,
      dedupeKey: `pmy:${what}:${groupId}:${minorId}:${g.userId}:${Math.floor(Date.now() / 60_000)}`,
    });
}

// ------------------------------------------------------------------ what a guardian reads

export interface ReadOnlyMessage {
  id: number;
  /** The child wrote it. */
  child: boolean;
  from: SeatLabel | null;
  body: string | null;
  removed?: boolean;
  at: string;
}

/**
 * A guardian reads their child's group thread, read-only, "as the guardian of {child}": the messages the child can see (what the child
 * blocked is not shown; what a supervisor removed is shown as removed), other children by their short names as the thread shows them. Only a
 * live guardian of a child with a login, and only a group the child is a member of: whether or not consent is on. Each read is recorded
 * in the group's record. Reading marks nothing as read for the child and writes nothing.
 */
export async function guardianThreadView(guardianId: number, participantId: unknown, groupId: number): Promise<{ ok: true; group: string; child: string; consentOn: boolean; messages: ReadOnlyMessage[] } | YouthRefusal> {
  const found = await guardianChild(guardianId, participantId);
  if ("ok" in found) return found;
  const { child } = found;
  const db = getDb();
  const y = await youthGroupOf(groupId);
  if (!y || y.endedAt) return refuseYouth("YG_NOT_YOUTH");
  const member = await db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'member'").get(groupId, child.minorId);
  if (!member) return refuseYouth("YG_CHILD_NOT_IN");
  const group = (await db.prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string };
  const thread = (await db.prepare("SELECT id, youth_since_id, staff_state FROM player_message_threads WHERE context_kind = 'group' AND context_id = ? AND youth = 1").get(groupId)) as
    | { id: number; youth_since_id: number; staff_state: string }
    | undefined;
  const rows = thread && thread.staff_state !== "closed"
    ? ((await db
        .prepare(
          `SELECT m.id, m.sender_id, m.sender_label, m.body, m.created_at, m.hidden_at FROM player_messages m
            WHERE m.thread_id = ? AND m.id > ? AND ${VISIBLE} ORDER BY m.id DESC LIMIT 200`
        )
        .all(thread.id, thread.youth_since_id, child.minorId, child.minorId, child.minorId)) as {
        id: number; sender_id: number | null; sender_label: string | null; body: string | null; created_at: string; hidden_at: string | null;
      }[])
    : [];
  await youthEvent(groupId, "guardian", "guardian_read", { actorId: guardianId, minorId: child.minorId });
  const consent = await db
    .prepare("SELECT 1 FROM youth_message_consents WHERE group_id = ? AND minor_user_id = ? AND revoked_at IS NULL")
    .get(groupId, child.minorId);
  return {
    ok: true,
    group: group.name,
    child: shortName(child.displayName),
    consentOn: Boolean(consent),
    messages: rows.reverse().map((m) => ({
      id: m.id, child: m.sender_id === child.minorId, from: parseLabel(m.sender_label), body: m.hidden_at ? null : m.body, at: m.created_at, ...(m.hidden_at ? { removed: true } : {}),
    })),
  };
}

/**
 * What a guardian's own data export holds of their children's group messages: for each child with a login the guardian answers for, the
 * youth threads they wrote in or read, with the messages they could see (a removed message without its words). Part of `messagesExport`.
 */
export async function youthExportForGuardian(guardianId: number): Promise<unknown[]> {
  const { guardianshipsOf } = await import("./participants");
  const db = getDb();
  const out: unknown[] = [];
  for (const { participant } of await guardianshipsOf(guardianId)) {
    const link = (await db.prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(participant.id)) as { linked_user_id: number | null } | undefined;
    const minorId = link?.linked_user_id ?? null;
    if (minorId === null) continue;
    const threads = (await db
      .prepare(
        `SELECT t.id, t.context_id, t.youth_since_id, g.name FROM player_message_threads t JOIN community_groups g ON g.id = t.context_id
          WHERE t.youth = 1 AND t.context_kind = 'group'
            AND (t.id IN (SELECT thread_id FROM player_message_reads WHERE user_id = ?) OR t.id IN (SELECT thread_id FROM player_messages WHERE sender_id = ?)) ORDER BY t.id`
      )
      .all(minorId, minorId)) as { id: number; context_id: number; youth_since_id: number; name: string }[];
    for (const t of threads) {
      const messages = (await db
        .prepare(
          `SELECT m.id, (m.sender_id = ?) AS by_child, m.sender_label AS from_label, CASE WHEN m.hidden_at IS NULL THEN m.body END AS body, m.created_at
             FROM player_messages m WHERE m.thread_id = ? AND m.id > ? AND ${VISIBLE} ORDER BY m.id`
        )
        .all(minorId, t.id, t.youth_since_id, minorId, minorId, minorId)) as Record<string, unknown>[];
      out.push({ child: participant.displayName, group: t.name, messages });
    }
  }
  return out;
}

// ------------------------------------------------------------------ what staff see

export interface YouthGroupForStaff {
  groupId: number;
  name: string;
  organiser: string;
  /** This venue was asked and has not answered. */
  pending: boolean;
  ended: boolean;
  venueId: number | null;
  supervisors: { name: string; declaredRole: DeclaredRole }[];
  adults: { name: string; declaredRole: DeclaredRole }[];
  minors: number;
  threadId: number | null;
  threadState: "open" | "muted" | "closed" | null;
  messages: number;
  openReports: number;
}

/** The supervised youth groups that are this staff member's: a venue's manager sees those that asked their venue (the pending ones to answer, the accepted ones to read); the platform owner those with no venue. No message text. */
export async function listYouthGroupsForStaff(admin: Admin): Promise<YouthGroupForStaff[]> {
  const scope = scopeOf(admin);
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT y.group_id, g.name, u.name AS organiser, y.venue_id, y.venue_requested_id, y.ended_at, t.id AS thread_id, t.staff_state, COALESCE(t.message_count, 0) AS messages,
              (SELECT COUNT(*)::int FROM player_message_reports r WHERE r.context_kind = 'group' AND r.context_id = y.group_id AND r.status = 'open') AS open_reports
         FROM youth_groups y JOIN community_groups g ON g.id = y.group_id JOIN users u ON u.id = g.organiser_id
         LEFT JOIN player_message_threads t ON t.context_kind = 'group' AND t.context_id = y.group_id AND t.youth = 1
        WHERE ${scope.owner ? "y.venue_id IS NULL" : scope.venueIds.length === 0 ? "FALSE" : `(y.venue_id IN (${scope.venueIds.map(() => "?").join(",")}) OR y.venue_requested_id IN (${scope.venueIds.map(() => "?").join(",")}))`}
        ORDER BY y.group_id DESC LIMIT 200`
    )
    .all(...(scope.owner ? [] : [...scope.venueIds, ...scope.venueIds]))) as {
    group_id: number; name: string; organiser: string; venue_id: number | null; venue_requested_id: number | null; ended_at: string | null;
    thread_id: number | null; staff_state: "open" | "muted" | "closed" | null; messages: number; open_reports: number;
  }[];
  const out: YouthGroupForStaff[] = [];
  for (const r of rows) {
    const adults = (await db
      .prepare("SELECT u.name, a.role, a.declared_role FROM youth_group_adults a JOIN users u ON u.id = a.user_id WHERE a.group_id = ? AND a.removed_at IS NULL ORDER BY a.id")
      .all(r.group_id)) as { name: string; role: "supervisor" | "adult"; declared_role: DeclaredRole }[];
    const minors = (await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM group_members m WHERE m.group_id = ? AND m.status = 'member'
            AND NOT EXISTS (SELECT 1 FROM player_profiles p WHERE p.user_id = m.user_id AND p.adult = 1)`
      )
      .get(r.group_id)) as { n: number };
    out.push({
      groupId: r.group_id,
      name: r.name,
      organiser: firstName(r.organiser),
      pending: r.venue_id === null && r.venue_requested_id !== null && !scope.owner,
      ended: r.ended_at !== null,
      venueId: r.venue_id,
      supervisors: adults.filter((a) => a.role === "supervisor").map((a) => ({ name: firstName(a.name), declaredRole: a.declared_role })),
      adults: adults.filter((a) => a.role === "adult").map((a) => ({ name: firstName(a.name), declaredRole: a.declared_role })),
      minors: minors.n,
      threadId: r.thread_id,
      threadState: r.staff_state,
      messages: r.messages,
      openReports: r.open_reports,
    });
  }
  return out;
}

export interface StaffYouthMessage {
  id: number;
  from: SeatLabel | null;
  body: string | null;
  removed: boolean;
  at: string;
}

/**
 * Staff read a supervised youth group's thread, for moderation and safeguarding review: a manager of the venue that accepted the group, or
 * the platform owner for a group with no venue; never front desk (the route is manager-only), never a group that has not asked this
 * venue. Each view is written to the staff activity log (by group number, never any text) and to the group's own record. A message a
 * supervisor removed is shown to staff with its words, marked removed, until it is deleted.
 */
export async function staffReadYouthThread(admin: Admin, groupId: number): Promise<{ ok: true; group: string; messages: StaffYouthMessage[] } | YouthRefusal> {
  const y = await youthGroupOf(groupId);
  if (!y || !inScope(scopeOf(admin), y.venueId)) return refuseYouth("YG_NOT_FOUND");
  const db = getDb();
  const group = (await db.prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
  if (!group) return refuseYouth("YG_NOT_FOUND");
  const thread = (await db.prepare("SELECT id, youth_since_id FROM player_message_threads WHERE context_kind = 'group' AND context_id = ? AND youth = 1").get(groupId)) as
    | { id: number; youth_since_id: number }
    | undefined;
  const rows = thread
    ? ((await db
        .prepare("SELECT id, sender_label, body, created_at, hidden_at FROM player_messages WHERE thread_id = ? AND id > ? ORDER BY id DESC LIMIT 200")
        .all(thread.id, thread.youth_since_id)) as { id: number; sender_label: string | null; body: string | null; created_at: string; hidden_at: string | null }[])
    : [];
  await logAction(admin, { venueId: y.venueId, action: "messages.youth_viewed", detail: `Read the conversation of supervised youth group ${groupId}` });
  await youthEvent(groupId, "staff", "staff_read", { detail: admin.name });
  return {
    ok: true,
    group: group.name,
    messages: rows.reverse().map((m) => ({ id: m.id, from: parseLabel(m.sender_label), body: m.body, removed: m.hidden_at !== null, at: m.created_at })),
  };
}

/**
 * A manager of the venue a group asked accepts or declines (lib/youth-messages.ts `answerVenueRequest`): logged in the activity log. Only a
 * manager of that venue (the route is manager-only); the platform owner does not answer for a venue.
 */
export async function staffAnswerVenue(admin: Admin, groupId: number, accept: boolean): Promise<{ ok: true } | YouthRefusal> {
  const done = await answerVenueRequest({ name: admin.name, venueIds: admin.venueIds ?? [] }, groupId, accept);
  if (!done.ok) return done;
  await logAction(admin, { venueId: done.venueId, action: "messages.youth_group_answered", detail: `Supervised youth group ${groupId}: ${accept ? "accepted" : "declined"}` });
  return { ok: true };
}

/** Staff end a supervised youth group in their scope, with a reason: its conversation is closed for good and the supervisors and the minors' guardians are told. */
export async function staffEndYouthGroup(admin: Admin, groupId: number, reason: unknown): Promise<{ ok: true } | YouthRefusal> {
  const y = await youthGroupOf(groupId);
  const done = await endYouthGroup({ staffName: admin.name, allowed: !!y && inScope(scopeOf(admin), y.venueId) }, groupId, reason);
  if (!done.ok) return done;
  await logAction(admin, { venueId: y?.venueId ?? null, action: "messages.youth_group_ended", detail: `Supervised youth group ${groupId}. ${typeof reason === "string" ? reason.trim().slice(0, 200) : ""}` });
  await tellThreadClosed(groupId).catch(() => undefined);
  return { ok: true };
}

/** Staff take an adult out of a youth group's conversation, with a reason (a safeguarding step: the organiser is never removed this way). */
export async function staffRemoveYouthAdult(admin: Admin, groupId: number, memberUserId: unknown, reasonRaw: unknown): Promise<{ ok: true } | YouthRefusal> {
  const reason = typeof reasonRaw === "string" && reasonRaw.trim().length >= 3 ? reasonRaw.trim().replace(/\s+/g, " ").slice(0, 300) : null;
  if (!reason) return refuseYouth("YG_REASON");
  const y = await youthGroupOf(groupId);
  if (!y || !inScope(scopeOf(admin), y.venueId) || y.endedAt) return refuseYouth("YG_NOT_FOUND");
  if (!Number.isInteger(memberUserId)) return refuseYouth("YG_MEMBER");
  const db = getDb();
  const organiser = (await db.prepare("SELECT organiser_id FROM community_groups WHERE id = ?").get(groupId)) as { organiser_id: number } | undefined;
  if (organiser?.organiser_id === memberUserId) return refuseYouth("YG_LAST_SUPERVISOR");
  const done = await db
    .prepare("UPDATE youth_group_adults SET removed_at = datetime('now'), removed_by = ? WHERE group_id = ? AND user_id = ? AND removed_at IS NULL")
    .run(`staff ${admin.name}`, groupId, memberUserId);
  if (done.changes === 0) return refuseYouth("YG_MEMBER");
  await youthEvent(groupId, "staff", "adult_removed", { detail: `person ${memberUserId}: ${reason}` });
  await logAction(admin, { venueId: y.venueId, action: "messages.youth_adult_removed", detail: `Supervised youth group ${groupId}, person ${memberUserId}. ${reason}` });
  return { ok: true };
}
