import { getDb, withTransaction } from "./db";
import { logAction } from "./activity";
import type { Admin } from "./admin-auth";
import { answerVenueRequest, endYouthGroup, guardianChild, refuseYouth, youthEvent, youthGroupOf, youthOff, type DeclaredRole, type YouthRefusal } from "./youth-messages";
import { youthMessagingEnabled, INTERIM_STANDARD } from "./youth-launch";
import { effectiveDecision, openAuthorityReviews, restrictionOfLevel, AUTHORITY_BASES, AUTHORITY_RESTRICTIONS, AUTHORITY_STATUSES, type AuthorityBasis, type AuthorityRestriction, type AuthorityStatus } from "./youth-authority";
import { groupHasActiveCase } from "./youth-evidence";
import { hasNumberRun } from "./youth-evidence-sql";
import { AUTHORITY_LEVELS, AUTHORITY_NOTE_MAX, consentEvent, consentInForce, lockConsentState, openObjectionOf, settleObjection, youthGroupsOfMember, type AuthorityLevel } from "./youth-consent";
import { adminIsAccusedIn, adminIsGuardianOrSupervisor, namesTheViewerSql } from "./safeguarding-conflict";
import type { SeatLabel } from "./message-contexts";
import { inScope, scopeOf } from "./message-moderation";
import { VISIBLE } from "./messages";
import { baseUrl, emailPlayer } from "./outbox";
import { siteName } from "./site";
import { staffSentences, tellOwnersEach, tellVenueStaffEach } from "./owner-alerts";
import { shortName } from "./public-names";
import { staffEmailsOf } from "./safeguarding-conflict";

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
        WHERE pt.linked_user_id = ? AND g.user_id IS NOT NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL AND g.messaging_authority <> 'none'`
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
 * A report in a youth group's thread: told at once (kind `safeguarding_notice`, email, never the text) to the live guardians of a minor who
 * reported or was reported, and to safeguarding personnel only: the managers of the group's venue, or the platform's owners where it has none
 * (ADR 0049). **Never the reported person, by any channel** (the group's supervisors are not told either: they are not safeguarding personnel, and
 * one of them may be the person reported), and never a member of staff who is the same person as the one reported (the conflict guard,
 * lib/safeguarding-conflict.ts): those are left out, and the platform's owners are told instead. Each notice is queued once per recipient and report.
 */
export async function tellUrgentReport(reportId: number): Promise<void> {
  const db = getDb();
  const r = (await db
    .prepare("SELECT id, context_id, venue_id, reporter_id, reported_id, escalated_at FROM player_message_reports WHERE id = ? AND urgent = 1")
    .get(reportId)) as { id: number; context_id: number; venue_id: number | null; reporter_id: number | null; reported_id: number | null; escalated_at: string | null } | undefined;
  if (!r) return;
  const group = (await db.prepare("SELECT name FROM community_groups WHERE id = ?").get(r.context_id)) as { name: string } | undefined;
  if (!group) return;
  const link = `${baseUrl()}/messages?open=group:${r.context_id}`;
  const told = new Set<number>();
  const tell = async (userId: number, key: "pmy.mail.report.guardianAbout" | "pmy.mail.report.guardianBy", vars: Record<string, string>) => {
    // Nobody is told through the person reported: not even as the guardian of the one who made the report.
    if (told.has(userId) || userId === r.reported_id) return;
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
  if (r.reported_id !== null && (await isMinorAccount(r.reported_id)))
    for (const g of await guardiansOfMinor(r.reported_id)) await tell(g.userId, "pmy.mail.report.guardianAbout", { child: g.child });
  if (r.reporter_id !== null && (await isMinorAccount(r.reporter_id)))
    for (const g of await guardiansOfMinor(r.reporter_id)) await tell(g.userId, "pmy.mail.report.guardianBy", { child: g.child });
  const write = (t: Parameters<Parameters<typeof tellOwnersEach>[0]>[0]) => ({
    subject: t("ysg.mail.reportSubject", { group: group.name }),
    body: staffSentences(t, t("ysg.mail.reportBody", { group: group.name, id: reportId })),
  });
  // Safeguarding personnel, leaving out whoever is the person reported; when the venue's own staff are conflicted the platform's owner is told instead.
  const conflicted = await staffEmailsOf(r.reported_id);
  const opts = { exceptEmails: conflicted, kind: "safeguarding_notice" as const };
  if (r.venue_id === null) await tellOwnersEach(write, opts);
  else {
    await tellVenueStaffEach(r.venue_id, write, { ...opts, managersOnly: true });
    if (conflicted.length > 0 || r.escalated_at !== null) await tellOwnersEach(write, opts);
  }
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
  // No youth thread can be read while youth messaging is not enabled on this install, a guardian's read-only view included (ADR 0052).
  { const off = youthOff(); if (off) return off; }
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
  const consent = await consentInForce(groupId, child.minorId);
  return {
    ok: true,
    group: group.name,
    child: shortName(child.displayName),
    consentOn: consent,
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
  for (const { participant, guardianship } of await guardianshipsOf(guardianId)) {
    const link = (await db.prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(participant.id)) as { linked_user_id: number | null } | undefined;
    const minorId = link?.linked_user_id ?? null;
    if (minorId === null) continue;
    // A guardian the venue recorded as having no say in messaging is given none of the child's group messages (ADR 0049).
    const level = (await db.prepare("SELECT messaging_authority FROM participant_guardians WHERE id = ?").get(guardianship.id)) as { messaging_authority: AuthorityLevel } | undefined;
    if (!level || level.messaging_authority === "none") continue;
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
  /** Authority reviews open for children of this group (ADR 0052): for safeguarding administrators only. */
  openReviews: number;
}

/** The supervised youth groups that are this staff member's: a venue's manager sees those that asked their venue (the pending ones to answer, the accepted ones to read); the platform owner those with no venue. No message text. */
export async function listYouthGroupsForStaff(admin: Admin): Promise<YouthGroupForStaff[]> {
  return (await youthGroupsOverview(admin)).groups;
}

/**
 * The groups that are this staff member's, and how many are held back: while youth messaging is not enabled on this install (lib/youth-launch.ts) only a
 * group with an **open case** (a report open or its restriction in force, an authority review or an appeal open, a legal hold) is listed, for safeguarding
 * administrators; the rest are stored and shown nowhere, and counted here so the screen can say so plainly.
 */
export async function youthGroupsOverview(admin: Admin): Promise<{ enabled: boolean; groups: YouthGroupForStaff[]; hidden: number }> {
  const enabled = youthMessagingEnabled();
  const all = await collectYouthGroups(admin);
  if (enabled) return { enabled, groups: all, hidden: 0 };
  const open: YouthGroupForStaff[] = [];
  for (const g of all) if (await groupHasActiveCase(g.groupId)) open.push(g);
  return { enabled, groups: open, hidden: all.length - open.length };
}

async function collectYouthGroups(admin: Admin): Promise<YouthGroupForStaff[]> {
  const scope = scopeOf(admin);
  const db = getDb();
  const names = namesTheViewerSql("r", admin);
  const rows = (await db
    .prepare(
      `SELECT y.group_id, g.name, u.name AS organiser, y.venue_id, y.venue_requested_id, y.ended_at, t.id AS thread_id, t.staff_state, COALESCE(t.message_count, 0) AS messages,
              (SELECT COUNT(*)::int FROM player_message_reports r WHERE r.context_kind = 'group' AND r.context_id = y.group_id AND r.status = 'open' AND NOT ${names.sql}) AS open_reports
         FROM youth_groups y JOIN community_groups g ON g.id = y.group_id JOIN users u ON u.id = g.organiser_id
         LEFT JOIN player_message_threads t ON t.context_kind = 'group' AND t.context_id = y.group_id AND t.youth = 1
        WHERE ${scope.owner ? "y.venue_id IS NULL" : scope.venueIds.length === 0 ? "FALSE" : `(y.venue_id IN (${scope.venueIds.map(() => "?").join(",")}) OR y.venue_requested_id IN (${scope.venueIds.map(() => "?").join(",")}))`}
        ORDER BY y.group_id DESC LIMIT 200`
    )
    .all(...names.args, ...(scope.owner ? [] : [...scope.venueIds, ...scope.venueIds]))) as {
    group_id: number; name: string; organiser: string; venue_id: number | null; venue_requested_id: number | null; ended_at: string | null;
    thread_id: number | null; staff_state: "open" | "muted" | "closed" | null; messages: number; open_reports: number;
  }[];
  const out: YouthGroupForStaff[] = [];
  for (const r of rows) {
    // A member of staff a report in the group names has no say over it while it stands: it is not listed as theirs (ADR 0049).
    if (await adminIsAccusedIn(admin, r.group_id)) continue;
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
      openReviews: ((await db.prepare("SELECT COUNT(*)::int AS n FROM youth_authority_reviews WHERE group_id = ? AND closed_at IS NULL").get(r.group_id)) as { n: number }).n,
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
  if (!y || !inScope(scopeOf(admin), y.venueId) || (await adminIsAccusedIn(admin, groupId))) return refuseYouth("YG_NOT_FOUND");
  // While youth messaging is not enabled only a group with an open case can be read, and only by its safeguarding administrators (ADR 0052).
  if (!youthMessagingEnabled() && !(await groupHasActiveCase(groupId))) return refuseYouth("YG_OFF");
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
  if (await adminIsAccusedIn(admin, groupId)) return refuseYouth("YG_NOT_FOUND");
  const done = await answerVenueRequest({ name: admin.name, venueIds: admin.venueIds ?? [] }, groupId, accept);
  if (!done.ok) return done;
  await logAction(admin, { venueId: done.venueId, action: "messages.youth_group_answered", detail: `Supervised youth group ${groupId}: ${accept ? "accepted" : "declined"}` });
  return { ok: true };
}

/** Staff end a supervised youth group in their scope, with a reason: its conversation is closed for good and the supervisors and the minors' guardians are told. */
export async function staffEndYouthGroup(admin: Admin, groupId: number, reason: unknown): Promise<{ ok: true } | YouthRefusal> {
  const y = await youthGroupOf(groupId);
  const done = await endYouthGroup({ staffName: admin.name, allowed: !!y && inScope(scopeOf(admin), y.venueId) && !(await adminIsAccusedIn(admin, groupId)) }, groupId, reason);
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
  if (!y || !inScope(scopeOf(admin), y.venueId) || y.endedAt || (await adminIsAccusedIn(admin, groupId))) return refuseYouth("YG_NOT_FOUND");
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

// ------------------------------------------------------------------ guardians in conflict: what safeguarding administrators see and do

/** Words about what the venue was shown, kept with a level: no document or identity number (a run of digits that long is refused). */
const noteOf = (raw: unknown): string | null | false => {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return false;
  const text = raw.trim().replace(/\s+/g, " ").slice(0, AUTHORITY_NOTE_MAX);
  if (hasNumberRun(text)) return false;
  return text || null;
};

/** The venues whose manager may record what a guardian may do about messaging for a child: the one that recorded the link, the child's own, a group's that accepted. */
async function authorityScopeAllows(admin: Admin, link: { link_venue: number | null; pt_venue: number | null; linked_user_id: number | null }): Promise<boolean> {
  const scope = scopeOf(admin);
  if (scope.owner) return true;
  if ((link.link_venue !== null && scope.venueIds.includes(link.link_venue)) || (link.pt_venue !== null && scope.venueIds.includes(link.pt_venue))) return true;
  if (link.linked_user_id === null) return false;
  for (const g of await youthGroupsOfMember(link.linked_user_id)) {
    const y = await youthGroupOf(g);
    if (y?.venueId !== null && y !== null && scope.venueIds.includes(y.venueId as number)) return true;
  }
  return false;
}

/**
 * A venue's manager (or the platform's owner) records a **decision about a guardian's authority** over the child's group messaging (ADR 0052, which amends
 * ADR 0049): a `status` (`asserted`, the default: what was declared, not a legal determination; `verified`: an authorised operator recorded a verified
 * decision; `disputed`; `unclear`), a `basis` (`parent`, `legal_guardian`, `other_authorised`, `not_stated`), what it `restrictions` removes from the guardian's
 * say (`none`, `may_object_only`, `no_messaging_say`; the older `level` words `decides`, `objects_only`, `none` mean the same) and a short note (no document
 * or identity number: a run of digits is refused). **A restriction takes effect only on a `verified` decision**: an asserted one sets the link to `unclear`
 * and the guardian keeps their say. `disputed` or `unclear` on any guardian link of the child keeps youth messaging for that child off until reviewed (an
 * authority review opens). Only an authorised operator may verify (the interim rule, pending legal review: a venue's manager for a participant the venue
 * manages, or the platform's owner); never a supervisor of the child's groups, never a guardian of the child, never staff who are the same person as one.
 * **MySenam does not interpret custody orders or make legal determinations**; it applies the recorded decision, with who, when and the standard label
 * `interim: pending legal review`. Audited (the staff activity log, and each youth group the child is in in its record) and serialised with every consent
 * change for the child. A demotion can complete a restoration the other guardians were waiting on, and it does so under the same locks.
 */
export async function staffSetGuardianAuthority(
  admin: Admin,
  input: { guardianshipId: unknown; level?: unknown; status?: unknown; basis?: unknown; restrictions?: unknown; note?: unknown }
): Promise<{ ok: true; status: AuthorityStatus; level: AuthorityLevel } | YouthRefusal> {
  if (input.level !== undefined && (typeof input.level !== "string" || !(AUTHORITY_LEVELS as readonly string[]).includes(input.level))) return refuseYouth("YG_LEVEL");
  const asked = {
    status: input.status === undefined ? null : input.status,
    basis: input.basis === undefined ? null : input.basis,
    restrictions: input.restrictions === undefined ? null : input.restrictions,
  };
  if (asked.status !== null && !(typeof asked.status === "string" && (AUTHORITY_STATUSES as readonly string[]).includes(asked.status))) return refuseYouth("YG_AUTH_INPUT");
  if (asked.basis !== null && !(typeof asked.basis === "string" && (AUTHORITY_BASES as readonly string[]).includes(asked.basis))) return refuseYouth("YG_AUTH_INPUT");
  if (asked.restrictions !== null && !(typeof asked.restrictions === "string" && (AUTHORITY_RESTRICTIONS as readonly string[]).includes(asked.restrictions))) return refuseYouth("YG_AUTH_INPUT");
  if (input.level === undefined && asked.status === null && asked.basis === null && asked.restrictions === null) return refuseYouth("YG_AUTH_INPUT");
  const note = noteOf(input.note);
  if (note === false) return refuseYouth("YG_NOTE_ID");
  if (!Number.isInteger(input.guardianshipId)) return refuseYouth("YG_NOT_FOUND");
  const db = getDb();
  type Link = {
    id: number; participant_id: number; user_id: number; messaging_authority: AuthorityLevel; link_venue: number | null; pt_venue: number | null; linked_user_id: number | null;
    authority_status: AuthorityStatus; authority_basis: AuthorityBasis; authority_restrictions: AuthorityRestriction;
  };
  const find = async () =>
    (await db
      .prepare(
        `SELECT g.id, g.participant_id, g.user_id, g.messaging_authority, g.venue_id AS link_venue, pt.venue_id AS pt_venue, pt.linked_user_id,
                g.authority_status, g.authority_basis, g.authority_restrictions
           FROM participant_guardians g JOIN participants pt ON pt.id = g.participant_id WHERE g.id = ? AND g.revoked_at IS NULL AND g.user_id IS NOT NULL`
      )
      .get(input.guardianshipId)) as Link | undefined;
  const first = await find();
  if (!first || !(await authorityScopeAllows(admin, first))) return refuseYouth("YG_NOT_FOUND");
  // A member of staff who is a guardian of the child, or a supervisor of a group the child is in, does not decide what the guardians may do.
  const guardianOfChild = await db
    .prepare("SELECT 1 FROM participant_guardians g JOIN users u ON u.id = g.user_id WHERE g.participant_id = ? AND u.email = ? LIMIT 1")
    .get(first.participant_id, admin.email);
  if (guardianOfChild) return refuseYouth("YG_NOT_FOUND");
  if (first.linked_user_id !== null)
    for (const g of await youthGroupsOfMember(first.linked_user_id)) if (await adminIsGuardianOrSupervisor(admin, g, first.linked_user_id)) return refuseYouth("YG_NOT_FOUND");
  const restrictions: AuthorityRestriction = (asked.restrictions as AuthorityRestriction | null) ?? (input.level !== undefined ? restrictionOfLevel(input.level as AuthorityLevel) : first.authority_restrictions);
  const status: AuthorityStatus = (asked.status as AuthorityStatus | null) ?? "asserted";
  const basis: AuthorityBasis = (asked.basis as AuthorityBasis | null) ?? first.authority_basis;
  // Interim, pending legal review: a verified decision, and any move out of `disputed` or `unclear`, is the platform owner's, or a manager's for a participant their
  // venue manages; a manager who only looks after a group the child is in may mark a link disputed or unclear, never clear it.
  const held = (x: AuthorityStatus) => x === "disputed" || x === "unclear";
  if (status === "verified" || (held(first.authority_status) && !held(effectiveDecision(status, restrictions).status))) {
    const scope = scopeOf(admin);
    if (!scope.owner && !((first.link_venue !== null && scope.venueIds.includes(first.link_venue)) || (first.pt_venue !== null && scope.venueIds.includes(first.pt_venue)))) return refuseYouth("YG_VERIFY");
  }
  if (status === "verified" && basis === "not_stated") return refuseYouth("YG_AUTH_INPUT");
  const result = await withTransaction(async (): Promise<{ ok: true; before: Link; status: AuthorityStatus; level: AuthorityLevel } | YouthRefusal> => {
    const groups = first.linked_user_id === null ? [] : await youthGroupsOfMember(first.linked_user_id);
    if (first.linked_user_id !== null) await lockConsentState(groups, first.linked_user_id);
    const link = await find();
    if (!link) return refuseYouth("YG_NOT_FOUND");
    const effect = effectiveDecision(status, restrictions);
    await db
      .prepare(
        `UPDATE participant_guardians SET messaging_authority = ?, authority_status = ?, authority_basis = ?, authority_restrictions = ?, authority_standard = ?,
                messaging_authority_by = ?, messaging_authority_at = datetime('now'), messaging_authority_note = ? WHERE id = ?`
      )
      .run(effect.level, effect.status, basis, restrictions, INTERIM_STANDARD, admin.name, note, link.id);
    if (link.linked_user_id !== null) {
      for (const g of groups) {
        await consentEvent(g, "staff", "authority_decided", {
          minorId: link.linked_user_id,
          detail: `guardian ${link.user_id}: ${link.authority_status} to ${effect.status}; basis ${basis}; restrictions ${restrictions}; ${INTERIM_STANDARD}`,
        });
        // A guardian who no longer decides stops counting: if the others have all agreed, the hold ends.
        await settleObjection(g, link.linked_user_id);
      }
      // A link that is disputed or unclear holds the child's messaging off and opens an authority review for each group (ADR 0052).
      if (effect.status === "disputed" || effect.status === "unclear") await openAuthorityReviews(link.linked_user_id, effect.status);
    }
    return { ok: true as const, before: link, status: effect.status, level: effect.level };
  });
  if (!result.ok) return result;
  await logAction(admin, {
    venueId: first.link_venue ?? first.pt_venue ?? null,
    action: "messages.youth_authority",
    detail: `Guardian link ${first.id}: status ${result.before.authority_status} to ${result.status}, restrictions ${result.before.authority_restrictions} to ${restrictions}, basis ${basis}`,
  });
  return { ok: true, status: result.status, level: result.level };
}

export interface SafeguardingChild {
  participantId: number;
  /** The child by their short name, as every public surface shows a child. */
  child: string;
  /** Messaging for this child here is off and needs the guardians who decide (or an administrator). Who objected is shown to administrators only. */
  objection: { id: number; at: string; by: string | null; level: "decides" | "objects_only" } | null;
  consentInForce: boolean;
  guardians: {
    guardianshipId: number; name: string; authority: AuthorityLevel; consentLive: boolean; note: string | null; setBy: string | null; setAt: string | null;
    /** The decision recorded about this link (ADR 0052): its status, basis, what it removes from the guardian's say, and the standard label it was recorded to. */
    status: AuthorityStatus; basis: AuthorityBasis; restrictions: AuthorityRestriction; standard: string | null;
  }[];
}

/**
 * What a safeguarding administrator sees of the children of a youth group whose own login is linked: any hold on their messaging (who opened it and
 * at what level: for administrators and the audit only), and each guardian with the level the venue recorded and its note. The venue's manager of an
 * accepted group, or the platform's owner for one with no venue: never front desk, never the child's supervisor or a guardian of the child, never a
 * staff member a report in the group names. Each reading is recorded.
 */
export async function staffSafeguardingView(admin: Admin, groupId: number): Promise<{ ok: true; group: string; children: SafeguardingChild[] } | YouthRefusal> {
  const y = await youthGroupOf(groupId);
  if (!y || !inScope(scopeOf(admin), y.venueId) || (await adminIsAccusedIn(admin, groupId))) return refuseYouth("YG_NOT_FOUND");
  const db = getDb();
  const group = (await db.prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
  if (!group) return refuseYouth("YG_NOT_FOUND");
  const kids = (await db
    .prepare(
      `SELECT m.user_id, u.name, pt.id AS participant_id FROM group_members m JOIN users u ON u.id = m.user_id JOIN participants pt ON pt.linked_user_id = m.user_id
        WHERE m.group_id = ? AND m.status = 'member' AND NOT EXISTS (SELECT 1 FROM player_profiles p WHERE p.user_id = m.user_id AND p.adult = 1) ORDER BY m.id`
    )
    .all(groupId)) as { user_id: number; name: string; participant_id: number }[];
  const children: SafeguardingChild[] = [];
  for (const k of kids) {
    // Never to a guardian or supervisor of this child, who is not a safeguarding administrator for it.
    if (await adminIsGuardianOrSupervisor(admin, groupId, k.user_id)) continue;
    const open = await openObjectionOf(groupId, k.user_id);
    const by = open?.guardianId ? ((await db.prepare("SELECT name FROM users WHERE id = ?").get(open.guardianId)) as { name: string } | undefined) : undefined;
    const rows = (await db
      .prepare(
        `SELECT g.id, g.user_id, u.name, g.messaging_authority, g.messaging_authority_note, g.messaging_authority_by, g.messaging_authority_at,
                g.authority_status, g.authority_basis, g.authority_restrictions, g.authority_standard,
                EXISTS (SELECT 1 FROM youth_message_consents c WHERE c.group_id = ? AND c.minor_user_id = ? AND c.guardian_user_id = g.user_id AND c.revoked_at IS NULL) AS consent_live
           FROM participant_guardians g JOIN users u ON u.id = g.user_id
          WHERE g.participant_id = ? AND g.user_id IS NOT NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL ORDER BY g.id`
      )
      .all(groupId, k.user_id, k.participant_id)) as {
      id: number; user_id: number; name: string; messaging_authority: AuthorityLevel; messaging_authority_note: string | null; messaging_authority_by: string | null; messaging_authority_at: string | null; consent_live: boolean;
      authority_status: AuthorityStatus; authority_basis: AuthorityBasis; authority_restrictions: AuthorityRestriction; authority_standard: string | null;
    }[];
    children.push({
      participantId: k.participant_id,
      child: shortName(k.name),
      objection: open ? { id: open.id, at: open.at, by: by ? firstName(by.name) : null, level: open.level } : null,
      consentInForce: await consentInForce(groupId, k.user_id),
      guardians: rows.map((g) => ({ guardianshipId: g.id, name: firstName(g.name), authority: g.messaging_authority, consentLive: g.consent_live, note: g.messaging_authority_note, setBy: g.messaging_authority_by, setAt: g.messaging_authority_at,
        status: g.authority_status, basis: g.authority_basis, restrictions: g.authority_restrictions, standard: g.authority_standard })),
    });
  }
  await logAction(admin, { venueId: y.venueId, action: "messages.youth_safeguarding_viewed", detail: `Read the guardians and holds of supervised youth group ${groupId}` });
  await youthEvent(groupId, "staff", "safeguarding_read", { detail: admin.name });
  return { ok: true, group: group.name, children };
}

/** Guardians who have a say are told the hold on messaging for their child has been settled by the venue: nothing of who objected or why. */
async function tellObjectionSettled(minorId: number, groupId: number): Promise<void> {
  const group = (await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
  if (!group) return;
  for (const g of await guardiansOfMinor(minorId))
    await emailPlayer({
      kind: "safeguarding_notice",
      venueId: null,
      userId: g.userId,
      subject: (t) => t("pmy.mail.subject", { site: siteName() }),
      body: (t) => t("pmy.mail.settled", { child: shortName(g.child), group: group.name }),
      link: `${baseUrl()}/account`,
      dedupeKey: `pmy:settled:${groupId}:${minorId}:${g.userId}:${Math.floor(Date.now() / 60_000)}`,
    });
}

/**
 * A safeguarding administrator settles a hold on a child's messaging in a group, with a mandatory reason (logged): the venue's manager of the
 * group's accepted venue, or the platform's owner for a group with no venue. **Never the child's supervisor, never a guardian of the child, never a
 * member of staff a report in the group names** (all are answered as a hold that is not there). Settling it ends the hold on consents; it does not
 * switch messaging on: a guardian who decides still has to consent (a child never has a seat without one).
 */
export async function staffResolveObjection(admin: Admin, objectionId: unknown, reasonRaw: unknown): Promise<{ ok: true } | YouthRefusal> {
  const reason = typeof reasonRaw === "string" && reasonRaw.trim().length >= 3 ? reasonRaw.trim().replace(/\s+/g, " ").slice(0, 300) : null;
  if (!reason) return refuseYouth("YG_REASON");
  if (!Number.isInteger(objectionId)) return refuseYouth("YG_NO_HOLD");
  const db = getDb();
  const row = (await db.prepare("SELECT id, group_id, minor_user_id FROM youth_message_objections WHERE id = ? AND closed_at IS NULL").get(objectionId)) as { id: number; group_id: number; minor_user_id: number } | undefined;
  const y = row ? await youthGroupOf(row.group_id) : null;
  if (!row || !y || !inScope(scopeOf(admin), y.venueId) || (await adminIsAccusedIn(admin, row.group_id)) || (await adminIsGuardianOrSupervisor(admin, row.group_id, row.minor_user_id))) return refuseYouth("YG_NO_HOLD");
  const done = await withTransaction(async (): Promise<boolean> => {
    await lockConsentState([row.group_id], row.minor_user_id);
    const closed = await db
      .prepare("UPDATE youth_message_objections SET closed_at = datetime('now'), close_kind = 'admin', closed_by = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL")
      .run(admin.name, reason, row.id);
    if (closed.changes === 0) return false;
    await consentEvent(row.group_id, "staff", "objection_resolved", { minorId: row.minor_user_id, detail: `objection ${row.id}: ${reason}` });
    return true;
  });
  if (!done) return refuseYouth("YG_NO_HOLD");
  await logAction(admin, { venueId: y.venueId, action: "messages.youth_objection_resolved", detail: `Supervised youth group ${row.group_id}, hold ${row.id}. ${reason}` });
  await tellObjectionSettled(row.minor_user_id, row.group_id).catch(() => undefined);
  return { ok: true };
}
