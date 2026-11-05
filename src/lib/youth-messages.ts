import { getDb, withTransaction } from "./db";
import { declaredAdult } from "./player-profiles";
import { shortName } from "./public-names";
import { region } from "./region";
import { venueZoneOf } from "./zones";
import { guardianshipOf } from "./participants";
import { blockPlayer } from "./player-safety";
import type { Seat, SeatLabel } from "./message-contexts";
import { consentInForce, consentInForceSql, lockConsentState, needsAgreement, recordSwitchOff, settleObjection, youthGroupsOfMember, type AuthorityLevel } from "./youth-consent";

/**
 * Supervised group messaging for eligible minors (docs/features/player-messages.md#supervised-youth-groups; ADR 0044).
 *
 * The owner's decision of 5 November 2026: allow supervised group messaging for eligible minors, prohibit unsolicited private
 * messaging. Everything below is what makes that safe by construction rather than by moderation afterwards:
 *
 * - **Who is an eligible minor.** An account that has not declared it is 18 or over (declared under 18, or not said), that is a member of
 *   a community group an adult organiser has marked as a supervised youth group, and that has all three of: its own opt-in, a live
 *   guardian's consent for this child and this group (the guardian of the participant whose own login the account is, default off,
 *   revocable, per child and per group), and the group being marked. Read live on every call (`youthSeats`); nothing is copied, so
 *   switching a consent off takes effect at once. Ages, guardianship, roles are the people's word: declared, never verified.
 * - **Group only, never private.** A minor has a seat only in a youth group's shared thread. There is no other thread a minor can be
 *   in (every other context's seats are adults who turned messaging on), no way for a minor to start a thread, and the thread opens only
 *   while at least `YOUTH_LIMITS.minSeats` people who can read it are there, one of them a supervisor: a supervisor and one child is a
 *   private conversation, and is refused. The database refuses a message from anybody not declared 18 or over outside a youth thread.
 * - **Supervision.** An adult supervisor with a declared role, recorded, is a member of the thread: never a space no adult is in. A
 *   supervisor can remove a message, mute a member and close the thread; staff of the group's venue can read it for safeguarding, each
 *   view audited; guardians can read their child's read-only.
 * - **Adults** are in the thread only if a supervisor let them in (`youth_group_adults`), each with a declared role, shown to guardians.
 *
 * No content scanning beyond the pattern speed bump (`youthContactPattern`); no machine learning; nothing learns.
 */

/** The refusals of this feature, in the shape of `Refusal` in lib/messages.ts (a code, a sentence, a status; the dictionaries hold the words). */
export interface YouthRefusal {
  ok: false;
  error: string;
  code: string;
  status: number;
  vars?: Record<string, string | number>;
}

const REFUSALS = {
  PM_YOUTH_FEW: ["This conversation opens once a supervisor and at least two other people have it switched on.", 409],
  PM_YOUTH_NEW_THREAD: ["A supervisor starts this conversation.", 409],
  PM_YOUTH_QUIET: ["Messages in this group rest between {from} and {to}.", 403],
  PM_YOUTH_MUTED: ["A supervisor has paused your messages in this group.", 403],
  PM_YOUTH_BLOCK_SUPERVISOR: ["A supervisor cannot be blocked here. Tell a guardian or report the message instead.", 409],
  YG_NOT_FOUND: ["That group is not here.", 404],
  YG_ORGANISER: ["Only the group's organiser can do that.", 403],
  YG_ADULT: ["Only somebody who has said they are 18 or over can do that.", 403],
  YG_ALREADY: ["This is already a supervised youth group.", 409],
  YG_NOT_YOUTH: ["This is not a supervised youth group.", 409],
  YG_ENDED: ["This group is no longer a supervised youth group.", 409],
  YG_MEMBER: ["That person is not a member of this group.", 404],
  YG_PERSON_ADULT: ["Only members who have said they are 18 or over can be supervisors or join the adults' conversation.", 409],
  YG_SUPERVISOR: ["Only a supervisor of this group can do that.", 403],
  YG_LAST_SUPERVISOR: ["A youth group needs at least one supervisor.", 409],
  YG_VENUE: ["No such venue.", 404],
  YG_REASON: ["Say why, in a few words.", 400],
  YG_ROLE: ["Choose a role: supervisor or adult, and say what you are (organiser, coach, venue staff, volunteer, parent or other).", 400],
  YG_QUIET: ["Give the rest hours as times of day, for example 21:30 and 07:30.", 400],
  YG_QUIET_SHORT: ["The group's rest hours can lengthen the install's, never shorten them.", 409],
  YG_TARGET: ["That message is not here.", 404],
  YG_OPTIN_ADULT: ["This is for players who have not said they are 18 or over.", 409],
  YG_NOT_MEMBER: ["You are not a member of that group.", 404],
  YG_NO_GUARDIAN: ["A guardian who manages your record has to be linked to this account first.", 409],
  YG_GUARDIAN: ["That is not one of the people you manage.", 404],
  YG_CHILD_NO_LOGIN: ["They have no login of their own linked, so there is nothing to switch on.", 409],
  YG_CHILD_NOT_IN: ["They are not a member of that group.", 409],
  YG_MODE: ["Choose how often the notices come: at once, in a digest, daily or not at all.", 400],
  YG_BLOCK_TARGET: ["That person is not in a conversation with them.", 404],
  YG_NO_SAY: ["Messaging for this child is not yours to change.", 403],
  YG_OBJECTS_ONLY: ["You can switch messaging off for this child, not on.", 403],
  YG_LEVEL: ["Choose whether this guardian decides about messaging, may only object, or has no say.", 400],
  YG_NOTE_ID: ["Say in words what you were shown. Do not enter identity or document numbers.", 400],
  YG_NO_HOLD: ["There is no hold on this child's messaging in this group.", 404],
} as const;
export type YouthRefusalCode = keyof typeof REFUSALS;

export function refuseYouth(code: YouthRefusalCode, vars?: Record<string, string | number>): YouthRefusal {
  const [text, status] = REFUSALS[code];
  return { ok: false, code, status, error: vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : text, ...(vars ? { vars } : {}) };
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
const clean = (raw: unknown, max = 300): string | null => (typeof raw === "string" && raw.trim().length >= 3 ? raw.trim().replace(/\s+/g, " ").slice(0, max) : null);

/** What a supervised youth group's conversation has to have to open: people who can read it, and a supervisor among them. */
export const YOUTH_MIN_SEATS = 3;

export const DECLARED_ROLES = ["organiser", "coach", "venue_staff", "volunteer", "parent", "other"] as const;
export type DeclaredRole = (typeof DECLARED_ROLES)[number];
export const NOTICE_MODES = ["immediate", "digest", "daily", "off"] as const;
export type GuardianNoticeMode = (typeof NOTICE_MODES)[number];

// ------------------------------------------------------------------ audit

export type ActorKind = "organiser" | "supervisor" | "guardian" | "minor" | "staff" | "system";

/** What was done about a youth group, by whom: never a message's text (a message is named by its number). */
export async function youthEvent(groupId: number, actorKind: ActorKind, action: string, opts: { actorId?: number | null; minorId?: number | null; detail?: string | null } = {}): Promise<void> {
  await getDb()
    .prepare("INSERT INTO youth_message_events (group_id, minor_user_id, actor_user_id, actor_kind, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(groupId, opts.minorId ?? null, opts.actorId ?? null, actorKind, action, opts.detail?.slice(0, 300) ?? null);
}

// ------------------------------------------------------------------ the group

export interface YouthGroup {
  groupId: number;
  /** The venue that accepted the group: its managers can read the thread for safeguarding and moderate. Null: the platform owner's. */
  venueId: number | null;
  venueRequestedId: number | null;
  quietFrom: number | null;
  quietTo: number | null;
  endedAt: string | null;
  markedBy: number | null;
  markedAt: string;
}

interface YouthGroupRow {
  group_id: number;
  venue_id: number | null;
  venue_requested_id: number | null;
  quiet_from_min: number | null;
  quiet_to_min: number | null;
  ended_at: string | null;
  marked_by: number | null;
  marked_at: string;
}

export async function youthGroupOf(groupId: number): Promise<YouthGroup | null> {
  const r = (await getDb()
    .prepare("SELECT group_id, venue_id, venue_requested_id, quiet_from_min, quiet_to_min, ended_at, marked_by, marked_at FROM youth_groups WHERE group_id = ?")
    .get(groupId)) as YouthGroupRow | undefined;
  return r
    ? { groupId: r.group_id, venueId: r.venue_id, venueRequestedId: r.venue_requested_id, quietFrom: r.quiet_from_min, quietTo: r.quiet_to_min, endedAt: r.ended_at, markedBy: r.marked_by, markedAt: r.marked_at }
    : null;
}

/**
 * Who has a seat in a youth group's thread, now: the supervisors and the adults a supervisor let in (who are members, declared adults
 * and have messaging on: the usual eligibility, applied by the caller), and each minor with every consent live. A minor's seat is
 * labelled with their short name, as every public surface shows a child; an adult by first name and their role.
 */
export async function youthSeats(groupId: number): Promise<Seat[]> {
  const db = getDb();
  // A group that is not marked, or no longer is, has no youth seats at all.
  const group = await youthGroupOf(groupId);
  if (!group || group.endedAt) return [];
  const adults = (await db
    .prepare(
      `SELECT a.user_id, a.role, u.name,
              EXISTS (SELECT 1 FROM youth_thread_mutes t WHERE t.group_id = a.group_id AND t.user_id = a.user_id AND t.lifted_at IS NULL) AS restricted
         FROM youth_group_adults a
         JOIN group_members m ON m.group_id = a.group_id AND m.user_id = a.user_id AND m.status = 'member'
         JOIN users u ON u.id = a.user_id
        WHERE a.group_id = ? AND a.removed_at IS NULL ORDER BY a.id`
    )
    .all(groupId)) as { user_id: number; role: "supervisor" | "adult"; name: string; restricted: boolean }[];
  const minors = (await db
    .prepare(
      `SELECT m.user_id, u.name FROM group_members m JOIN users u ON u.id = m.user_id
         JOIN youth_message_optins o ON o.group_id = m.group_id AND o.user_id = m.user_id AND o.revoked_at IS NULL
        WHERE m.group_id = ? AND m.status = 'member'
          AND NOT EXISTS (SELECT 1 FROM player_profiles p WHERE p.user_id = m.user_id AND p.adult = 1)
          AND ${consentInForceSql("m.group_id", "m.user_id")}
        ORDER BY m.id`
    )
    .all(groupId)) as { user_id: number; name: string }[];
  const minorIds = new Set(minors.map((m) => m.user_id));
  return [
    // An adult whose access is paused keeps a seat, only to be shown the neutral line: no supervisor's powers, nobody's reader (ADR 0049).
    ...adults
      .filter((a) => !minorIds.has(a.user_id))
      .map((a): Seat => (a.restricted ? { userId: a.user_id, role: "adult", restricted: true, from: { n: firstName(a.name), r: a.role } } : { userId: a.user_id, role: a.role, from: { n: firstName(a.name), r: a.role } })),
    ...minors.map((m): Seat => ({ userId: m.user_id, minor: true, from: { n: shortName(m.name) } })),
  ];
}

/**
 * Taken inside the sending transaction, `FOR SHARE`: the minor's opt-in, consents and live guardian relationships, and an adult's place,
 * so whoever switches one off waits for a message being written, or this sees it: a message is never written after a consent was
 * switched off. Nothing is locked for an account that has none of these (an ordinary member).
 */
export async function lockYouthSeat(groupId: number, userId: number): Promise<void> {
  const db = getDb();
  // The child's consent state first, before any row below: whoever changes it takes this row `FOR UPDATE` before the others, so neither waits for
  // the other in a circle, and a message is never written between an objection and what it ends (lib/youth-consent.ts).
  await db.prepare("SELECT 1 FROM youth_consent_locks WHERE group_id = ? AND minor_user_id = ? FOR SHARE").all(groupId, userId);
  await db.prepare("SELECT 1 FROM youth_message_optins WHERE group_id = ? AND user_id = ? AND revoked_at IS NULL FOR SHARE").all(groupId, userId);
  await db.prepare("SELECT 1 FROM youth_message_consents WHERE group_id = ? AND minor_user_id = ? AND revoked_at IS NULL FOR SHARE").all(groupId, userId);
  await db
    .prepare(
      `SELECT 1 FROM participant_guardians g JOIN participants pt ON pt.id = g.participant_id
        WHERE pt.linked_user_id = ? AND g.revoked_at IS NULL FOR SHARE OF g`
    )
    .all(userId);
  await db.prepare("SELECT 1 FROM youth_group_adults WHERE group_id = ? AND user_id = ? AND removed_at IS NULL FOR SHARE").all(groupId, userId);
  await db.prepare("SELECT 1 FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL FOR SHARE").all(groupId, userId);
}

// ------------------------------------------------------------------ the text: a stricter speed bump

/**
 * What a message in a youth group's thread may not carry, beyond a phone number or an email (lib/messages.ts `contactDetail`): a social
 * handle, the name of a chat or social service, a link or a web address, and the ways of asking for a private chat. A speed bump, not a
 * guarantee: somebody determined can spell it out, and nothing here understands what a message means. Applied to everybody in the thread.
 */
export function youthContactPattern(text: string): boolean {
  return (
    /(^|[^\w])@[a-z0-9_.]{3,}/i.test(text) ||
    /\b(whats\s?app|wa\.me|telegram|t\.me|insta(gram)?|snap\s?chat|tik\s?tok|discord|we\s?chat|kik|facebook|messenger)\b/i.test(text) ||
    /\b(dm|pm|inbox)\s+me\b|\badd me on\b|\bmy\s+(number|no\.?|phone|handle|username|insta|ig|id)\b/i.test(text) ||
    /https?:\/\/|www\./i.test(text) ||
    /\b[a-z0-9-]+\.(com|my|net|org|io|me|co|gg|ly|link|app|xyz)\b/i.test(text)
  );
}

// ------------------------------------------------------------------ quiet hours

export interface QuietWindow {
  /** Minutes after midnight, local time; the window runs from `from` to `to`, past midnight when `to` is before `from`. */
  from: number;
  to: number;
}

const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export { hhmm as clockOfMinute };

function parseClock(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/**
 * The install's quiet window for minors: `YOUTH_QUIET_HOURS`, "22:00-07:00" by default; "off" is the install operator's to choose (it is
 * not reachable from a venue, an organiser or a guardian). A value that does not parse is the default.
 */
export function installQuietWindow(): QuietWindow | null {
  const raw = process.env.YOUTH_QUIET_HOURS?.trim() ?? "";
  if (raw.toLowerCase() === "off") return null;
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(raw);
  const from = m ? parseClock(m[1]) : null;
  const to = m ? parseClock(m[2]) : null;
  return from !== null && to !== null && from !== to ? { from, to } : { from: 22 * 60, to: 7 * 60 };
}

/** Minutes after midnight in `zone` at this moment: right on either side of a daylight-saving change, as the zone's own clock reads. */
export function localMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

export function inWindow(minute: number, w: QuietWindow): boolean {
  return w.from < w.to ? minute >= w.from && minute < w.to : minute >= w.from || minute < w.to;
}

/** The window that is in force at `at` in `zone`, if any of these is: the first that holds. */
export function quietNow(at: Date, zone: string, windows: QuietWindow[]): QuietWindow | null {
  const minute = localMinutes(at, zone);
  return windows.find((w) => inWindow(minute, w)) ?? null;
}

/** The windows that apply to a group (its own, if it set one, and the install's) and the zone they are read in: the venue's, else the install's. */
export async function quietFor(group: YouthGroup): Promise<{ zone: string; windows: QuietWindow[] }> {
  const venue = group.venueId === null ? null : ((await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(group.venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined);
  const windows: QuietWindow[] = [];
  const install = installQuietWindow();
  if (install) windows.push(install);
  if (group.quietFrom !== null && group.quietTo !== null && group.quietFrom !== group.quietTo) windows.push({ from: group.quietFrom, to: group.quietTo });
  return { zone: venue ? venueZoneOf(venue) : region().timeZone, windows };
}

// ------------------------------------------------------------------ marking a group, supervisors

type Result<T = object> = ({ ok: true } & T) | YouthRefusal;

async function groupFor(groupId: number): Promise<{ id: number; name: string; organiser_id: number; status: string } | null> {
  return ((await getDb().prepare("SELECT id, name, organiser_id, status FROM community_groups WHERE id = ?").get(groupId)) ?? null) as { id: number; name: string; organiser_id: number; status: string } | null;
}

/** Whether this account is a live supervisor of the group's thread: a supervisor row, and still a member of the group. */
export async function isSupervisor(userId: number, groupId: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare(
        `SELECT 1 FROM youth_group_adults a JOIN group_members m ON m.group_id = a.group_id AND m.user_id = a.user_id AND m.status = 'member'
          WHERE a.group_id = ? AND a.user_id = ? AND a.role = 'supervisor' AND a.removed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM youth_thread_mutes t WHERE t.group_id = a.group_id AND t.user_id = a.user_id AND t.lifted_at IS NULL)`
      )
      .get(groupId, userId)
  );
}

/**
 * Whether this adult's access to the group's thread is paused (a pause by a supervisor or a hold a report placed: the same to them, and never
 * saying which). While it is, their powers over the group, as a supervisor or as its organiser, are suspended too (ADR 0049).
 */
export async function accessPaused(groupId: number, userId: number): Promise<boolean> {
  return Boolean(await getDb().prepare("SELECT 1 FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL").get(groupId, userId));
}

/** An organiser-only action: the organiser, and not paused (a paused organiser gets the answer a stranger gets, saying nothing about why). */
async function organiserRefusal(g: { organiser_id: number }, userId: number, groupId: number): Promise<YouthRefusal | null> {
  if (g.organiser_id !== userId) return refuseYouth("YG_ORGANISER");
  return (await accessPaused(groupId, userId)) ? refuseYouth("YG_NOT_FOUND") : null;
}

/**
 * The organiser marks their group as a supervised youth group. Only the group's organiser, a declared adult; they become its first
 * supervisor (declared role: organiser). What was written in the group's thread before is never shown in it. Marking is an advanced
 * setting of a group: nothing about it is part of anybody's setup.
 */
export async function markYouthGroup(userId: number, groupId: number): Promise<Result> {
  const g = await groupFor(groupId);
  if (!g) return refuseYouth("YG_NOT_FOUND");
  if (g.organiser_id !== userId) return refuseYouth("YG_ORGANISER");
  if ((await declaredAdult(userId)) !== true) return refuseYouth("YG_ADULT");
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(groupId);
    if (await youthGroupOf(groupId)) return refuseYouth("YG_ALREADY");
    await db.prepare("INSERT INTO youth_groups (group_id, marked_by) VALUES (?, ?)").run(groupId, userId);
    await db
      .prepare("INSERT INTO youth_group_adults (group_id, user_id, role, declared_role, added_by) VALUES (?, ?, 'supervisor', 'organiser', ?) ON CONFLICT DO NOTHING")
      .run(groupId, userId, userId);
    // A thread that already holds adults' messages becomes the youth thread, showing nothing from before.
    await db
      .prepare(
        `UPDATE player_message_threads SET youth = 1, youth_since_id = (SELECT COALESCE(MAX(m.id), 0) FROM player_messages m WHERE m.thread_id = player_message_threads.id)
          WHERE context_kind = 'group' AND context_id = ?`
      )
      .run(groupId);
    await youthEvent(groupId, "organiser", "marked", { actorId: userId });
    return { ok: true as const };
  });
}

/** Closes the thread for good: a group that stops being a youth group never has its conversation shown as an ordinary one. */
async function closeThread(groupId: number, by: string, reason: string): Promise<void> {
  await getDb()
    .prepare("UPDATE player_message_threads SET staff_state = 'closed', staff_reason = ?, staff_admin_name = ?, staff_at = datetime('now') WHERE context_kind = 'group' AND context_id = ? AND staff_state <> 'closed'")
    .run(reason, by, groupId);
}

/**
 * The organiser (or staff, `allowed` having been decided by the caller from the staff member's scope: a manager of the group's venue, the
 * platform owner for a group with none) ends the youth group: its thread is closed for good and its seats go.
 */
export async function endYouthGroup(actor: { userId: number } | { staffName: string; allowed: boolean }, groupId: number, reasonRaw: unknown): Promise<Result> {
  const reason = clean(reasonRaw);
  if (!reason) return refuseYouth("YG_REASON");
  const g = await groupFor(groupId);
  const y = await youthGroupOf(groupId);
  if (!g || !y) return refuseYouth("YG_NOT_FOUND");
  if (y.endedAt) return refuseYouth("YG_ENDED");
  if ("userId" in actor ? g.organiser_id !== actor.userId : !actor.allowed) return "userId" in actor ? refuseYouth("YG_ORGANISER") : refuseYouth("YG_NOT_FOUND");
  if ("userId" in actor && (await accessPaused(groupId, actor.userId))) return refuseYouth("YG_NOT_FOUND");
  const by = "userId" in actor ? "organiser" : actor.staffName;
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("UPDATE youth_groups SET ended_at = datetime('now'), ended_by = ?, ended_reason = ? WHERE group_id = ? AND ended_at IS NULL").run(by, reason, groupId);
    await closeThread(groupId, by, reason);
    await youthEvent(groupId, "userId" in actor ? "organiser" : "staff", "ended", { actorId: "userId" in actor ? actor.userId : null, detail: reason });
    return { ok: true as const };
  });
}

/** The organiser asks a venue to look after the group (or withdraws the request, `venueId` null). Until a manager accepts, the platform owner moderates it. */
export async function requestVenue(userId: number, groupId: number, venueId: number | null): Promise<Result> {
  const g = await groupFor(groupId);
  const y = await youthGroupOf(groupId);
  if (!g || !y) return refuseYouth("YG_NOT_FOUND");
  { const no = await organiserRefusal(g, userId, groupId); if (no) return no; }
  if (y.endedAt) return refuseYouth("YG_ENDED");
  if (venueId !== null && !(await getDb().prepare("SELECT 1 FROM venues WHERE id = ?").get(venueId))) return refuseYouth("YG_VENUE");
  await getDb().prepare("UPDATE youth_groups SET venue_requested_id = ? WHERE group_id = ?").run(venueId, groupId);
  await youthEvent(groupId, "organiser", venueId === null ? "venue_request_withdrawn" : "venue_requested", { actorId: userId, detail: venueId === null ? null : `venue ${venueId}` });
  return { ok: true as const };
}

/**
 * A manager of the venue a group asked for accepts or declines. Accepting makes the venue the group's own for moderation and
 * safeguarding: its managers see the group's reports and can read its thread (each view audited); the thread and the reports so far
 * move to the venue. Declining clears the request. Never done for a venue the manager does not manage, nor for a group that did not ask.
 */
export async function answerVenueRequest(admin: { name: string; venueIds: number[] }, groupId: number, accept: boolean): Promise<Result<{ venueId: number }>> {
  const y = await youthGroupOf(groupId);
  if (!y || y.venueRequestedId === null || !admin.venueIds.includes(y.venueRequestedId)) return refuseYouth("YG_NOT_FOUND");
  if (y.endedAt) return refuseYouth("YG_ENDED");
  const venueId = y.venueRequestedId;
  return withTransaction(async () => {
    const db = getDb();
    if (!accept) {
      await db.prepare("UPDATE youth_groups SET venue_requested_id = NULL WHERE group_id = ?").run(groupId);
      await youthEvent(groupId, "staff", "venue_declined", { detail: `venue ${venueId}` });
      return { ok: true as const, venueId };
    }
    await db.prepare("UPDATE youth_groups SET venue_id = ?, venue_requested_id = NULL, venue_confirmed_by = ?, venue_confirmed_at = datetime('now') WHERE group_id = ?").run(venueId, admin.name, groupId);
    await db.prepare("UPDATE player_message_threads SET venue_id = ? WHERE context_kind = 'group' AND context_id = ?").run(venueId, groupId);
    await db.prepare("UPDATE player_message_reports SET venue_id = ? WHERE context_kind = 'group' AND context_id = ?").run(venueId, groupId);
    await youthEvent(groupId, "staff", "venue_accepted", { detail: `venue ${venueId}` });
    return { ok: true as const, venueId };
  });
}

/** The organiser lengthens the group's rest hours (never shortens the install's: a restriction is never weakened by a setting a venue or organiser can reach). `null` clears the group's own. */
export async function setGroupQuiet(userId: number, groupId: number, input: { from: unknown; to: unknown } | null): Promise<Result> {
  const g = await groupFor(groupId);
  const y = await youthGroupOf(groupId);
  if (!g || !y) return refuseYouth("YG_NOT_FOUND");
  { const no = await organiserRefusal(g, userId, groupId); if (no) return no; }
  if (y.endedAt) return refuseYouth("YG_ENDED");
  let from: number | null = null;
  let to: number | null = null;
  if (input) {
    from = typeof input.from === "string" ? parseClock(input.from) : null;
    to = typeof input.to === "string" ? parseClock(input.to) : null;
    if (from === null || to === null || from === to) return refuseYouth("YG_QUIET");
  }
  await getDb().prepare("UPDATE youth_groups SET quiet_from_min = ?, quiet_to_min = ? WHERE group_id = ?").run(from, to, groupId);
  await youthEvent(groupId, "organiser", "quiet_set", { actorId: userId, detail: from === null ? "cleared" : `${hhmm(from)}-${hhmm(to!)}` });
  return { ok: true as const };
}

/**
 * The organiser lets an adult member into the thread, as a supervisor or an adult, saying what they are (declared, never verified), or
 * takes them out. Only an adult member who has declared they are 18 or over. The organiser is always a supervisor and stays one.
 */
export async function setYouthAdult(userId: number, groupId: number, input: { memberUserId: unknown; role: unknown; declaredRole: unknown; remove?: unknown }): Promise<Result> {
  const g = await groupFor(groupId);
  const y = await youthGroupOf(groupId);
  if (!g || !y) return refuseYouth("YG_NOT_FOUND");
  { const no = await organiserRefusal(g, userId, groupId); if (no) return no; }
  if (y.endedAt) return refuseYouth("YG_ENDED");
  const target = input.memberUserId;
  if (!Number.isInteger(target)) return refuseYouth("YG_MEMBER");
  const memberId = target as number;
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT id FROM community_groups WHERE id = ? FOR UPDATE").get(groupId);
    if (input.remove === true) {
      if (memberId === g.organiser_id) return refuseYouth("YG_LAST_SUPERVISOR");
      const done = await db.prepare("UPDATE youth_group_adults SET removed_at = datetime('now'), removed_by = 'organiser' WHERE group_id = ? AND user_id = ? AND removed_at IS NULL").run(groupId, memberId);
      if (done.changes === 0) return refuseYouth("YG_MEMBER");
      await youthEvent(groupId, "organiser", "adult_removed", { actorId: userId, detail: `person ${memberId}` });
      return { ok: true as const };
    }
    if (input.role !== "supervisor" && input.role !== "adult") return refuseYouth("YG_ROLE");
    if (typeof input.declaredRole !== "string" || !(DECLARED_ROLES as readonly string[]).includes(input.declaredRole)) return refuseYouth("YG_ROLE");
    const member = await db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'member'").get(groupId, memberId);
    if (!member) return refuseYouth("YG_MEMBER");
    if ((await declaredAdult(memberId)) !== true) return refuseYouth("YG_PERSON_ADULT");
    // The organiser's own role stays as it is.
    const role = memberId === g.organiser_id ? "supervisor" : input.role;
    const declared = memberId === g.organiser_id ? "organiser" : input.declaredRole;
    await db.prepare("UPDATE youth_group_adults SET removed_at = datetime('now'), removed_by = 'organiser (changed)' WHERE group_id = ? AND user_id = ? AND removed_at IS NULL AND (role <> ? OR declared_role <> ?)").run(groupId, memberId, role, declared);
    await db
      .prepare("INSERT INTO youth_group_adults (group_id, user_id, role, declared_role, added_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(groupId, memberId, role, declared, userId);
    await youthEvent(groupId, "organiser", "adult_added", { actorId: userId, detail: `person ${memberId}: ${role}, ${declared}` });
    return { ok: true as const };
  });
}

export interface YouthGroupState {
  groupId: number;
  name: string;
  marked: boolean;
  ended: boolean;
  organiser: boolean;
  supervisor: boolean;
  venue: { id: number; name: string } | null;
  venueRequested: { id: number; name: string } | null;
  quiet: { installFrom: string; installTo: string } | { off: true };
  groupQuiet: { from: string; to: string } | null;
  /** The adults in the thread, and the members who could be let in. Roster first names only. */
  adults: { userId: number; name: string; role: "supervisor" | "adult"; declaredRole: DeclaredRole }[];
  candidates: { userId: number; name: string }[];
  minors: number;
  /** Whether the conversation is open now: a supervisor and enough people. */
  openSeats: number;
  mutes: { id: number; label: SeatLabel; source: "supervisor" | "report" }[];
}

/** What the organiser (or any supervisor) sees of a group's youth settings: only for them, in the group's advanced settings. */
export async function youthGroupState(userId: number, groupId: number): Promise<YouthGroupState | YouthRefusal> {
  const g = await groupFor(groupId);
  if (!g) return refuseYouth("YG_NOT_FOUND");
  // A person whose access is paused has none of an organiser's or a supervisor's powers, and is told nothing of why (ADR 0049).
  const organiser = g.organiser_id === userId && !(await accessPaused(groupId, userId));
  const supervisor = organiser || (await isSupervisor(userId, groupId));
  if (!supervisor) return refuseYouth("YG_NOT_FOUND");
  const y = await youthGroupOf(groupId);
  const db = getDb();
  const venueName = async (id: number | null) => (id === null ? null : ((await db.prepare("SELECT id, name FROM venues WHERE id = ?").get(id)) as { id: number; name: string } | undefined) ?? null);
  const install = installQuietWindow();
  const adults = y
    ? ((await db
        .prepare(
          `SELECT a.user_id, a.role, a.declared_role, u.name FROM youth_group_adults a JOIN users u ON u.id = a.user_id
            WHERE a.group_id = ? AND a.removed_at IS NULL ORDER BY a.id`
        )
        .all(groupId)) as { user_id: number; role: "supervisor" | "adult"; declared_role: DeclaredRole; name: string }[])
    : [];
  const candidates = organiser
    ? ((await db
        .prepare(
          `SELECT m.user_id, u.name FROM group_members m JOIN users u ON u.id = m.user_id JOIN player_profiles p ON p.user_id = m.user_id AND p.adult = 1
            WHERE m.group_id = ? AND m.status = 'member'
              AND NOT EXISTS (SELECT 1 FROM youth_group_adults a WHERE a.group_id = m.group_id AND a.user_id = m.user_id AND a.removed_at IS NULL)
            ORDER BY m.id`
        )
        .all(groupId)) as { user_id: number; name: string }[])
    : [];
  const mutes = y
    ? ((await db
        .prepare(
          `SELECT t.id, t.source, u.name FROM youth_thread_mutes t JOIN users u ON u.id = t.user_id WHERE t.group_id = ? AND t.lifted_at IS NULL AND t.source = 'supervisor' ORDER BY t.id`
        )
        .all(groupId)) as { id: number; source: "supervisor" | "report"; name: string }[])
    : [];
  const seats = y && !y.endedAt ? await youthSeats(groupId) : [];
  return {
    groupId,
    name: g.name,
    marked: !!y,
    ended: !!y?.endedAt,
    organiser,
    supervisor,
    venue: await venueName(y?.venueId ?? null),
    venueRequested: await venueName(y?.venueRequestedId ?? null),
    quiet: install ? { installFrom: hhmm(install.from), installTo: hhmm(install.to) } : { off: true },
    groupQuiet: y && y.quietFrom !== null && y.quietTo !== null ? { from: hhmm(y.quietFrom), to: hhmm(y.quietTo) } : null,
    adults: adults.map((a) => ({ userId: a.user_id, name: firstName(a.name), role: a.role, declaredRole: a.declared_role })),
    candidates: candidates.map((c) => ({ userId: c.user_id, name: firstName(c.name) })),
    minors: seats.filter((s) => s.minor).length,
    openSeats: seats.filter((s) => !s.restricted).length,
    mutes: mutes.map((m) => ({ id: m.id, label: { n: firstName(m.name) }, source: m.source })),
  };
}

// ------------------------------------------------------------------ the minor

export interface MyYouthGroup {
  groupId: number;
  name: string;
  sport: string;
  /** Who supervises, as declared: first names and what they said they are. */
  supervisors: { name: string; declaredRole: DeclaredRole }[];
  optedIn: boolean;
  /** A guardian has switched messaging on for this child in this group. */
  guardianOn: boolean;
  /** All three are live: the child has a seat in the conversation. */
  active: boolean;
}

/**
 * The supervised youth groups this account is in, with where each of the three consents stands, for the child's own first-use screen.
 * Only for an account that has not declared 18 or over; an adult is told nothing here.
 */
export async function myYouthGroups(userId: number): Promise<{ eligible: boolean; linked: boolean; groups: MyYouthGroup[] }> {
  const db = getDb();
  if ((await declaredAdult(userId)) === true) return { eligible: false, linked: false, groups: [] };
  const linked = Boolean(await db.prepare("SELECT 1 FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id WHERE pt.linked_user_id = ? AND g.user_id IS NOT NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL").get(userId));
  const rows = (await db
    .prepare(
      `SELECT g.id, g.name, g.sport FROM group_members m JOIN community_groups g ON g.id = m.group_id JOIN youth_groups y ON y.group_id = g.id AND y.ended_at IS NULL
        WHERE m.user_id = ? AND m.status = 'member' AND g.status = 'active' ORDER BY g.id`
    )
    .all(userId)) as { id: number; name: string; sport: string }[];
  const out: MyYouthGroup[] = [];
  for (const r of rows) {
    const sup = (await db
      .prepare(`SELECT u.name, a.declared_role FROM youth_group_adults a JOIN users u ON u.id = a.user_id WHERE a.group_id = ? AND a.role = 'supervisor' AND a.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM youth_thread_mutes pm WHERE pm.group_id = a.group_id AND pm.user_id = a.user_id AND pm.lifted_at IS NULL) ORDER BY a.id`)
      .all(r.id)) as { name: string; declared_role: DeclaredRole }[];
    const optedIn = Boolean(await db.prepare("SELECT 1 FROM youth_message_optins WHERE group_id = ? AND user_id = ? AND revoked_at IS NULL").get(r.id, userId));
    const guardianOn = Boolean(await guardianConsentLive(r.id, userId));
    const active = (await youthSeats(r.id)).some((s) => s.userId === userId);
    out.push({ groupId: r.id, name: r.name, sport: r.sport, supervisors: sup.map((s) => ({ name: firstName(s.name), declaredRole: s.declared_role })), optedIn, guardianOn, active });
  }
  return { eligible: true, linked, groups: out };
}

/** The guardians' side is in force: a consent from a guardian who decides, and no objection still waiting for them all (lib/youth-consent.ts). */
async function guardianConsentLive(groupId: number, minorId: number): Promise<boolean> {
  return consentInForce(groupId, minorId);
}

/**
 * The minor's own opt-in (or withdrawal) for a youth group they are a member of. Needs an account that has not declared 18 or over and
 * is linked to a participant a guardian manages; without a guardian there is nobody to consent, and nothing starts.
 */
export async function setMinorOptIn(userId: number, groupId: number, on: boolean): Promise<Result> {
  const y = await youthGroupOf(groupId);
  const member = await getDb().prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'member'").get(groupId, userId);
  if (!y || y.endedAt || !member) return refuseYouth("YG_NOT_MEMBER");
  if ((await declaredAdult(userId)) === true) return refuseYouth("YG_OPTIN_ADULT");
  return withTransaction(async () => {
    const db = getDb();
    if (!on) {
      await db.prepare("UPDATE youth_message_optins SET revoked_at = datetime('now') WHERE group_id = ? AND user_id = ? AND revoked_at IS NULL").run(groupId, userId);
      await youthEvent(groupId, "minor", "opt_out", { actorId: userId, minorId: userId });
      return { ok: true as const };
    }
    const guarded = await db
      .prepare("SELECT 1 FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id WHERE pt.linked_user_id = ? AND g.user_id IS NOT NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL")
      .get(userId);
    if (!guarded) return refuseYouth("YG_NO_GUARDIAN");
    await db.prepare("INSERT INTO youth_message_optins (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(groupId, userId);
    await youthEvent(groupId, "minor", "opt_in", { actorId: userId, minorId: userId });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ the guardian

interface ChildRow {
  participantId: number;
  displayName: string;
  minorId: number;
  /** This guardian's own link, and what the venue recorded they may do about the child's messaging (lib/youth-consent.ts). */
  guardianshipId: number;
  authority: AuthorityLevel;
}

/**
 * The child this guardian answers for, with their own login's account: only a live guardian, and only a participant with a login linked. A guardian
 * the venue recorded as having no say in messaging (`none`) gets the same refusal for everything here (ADR 0049).
 */
export async function guardianChild(guardianId: number, participantId: unknown): Promise<{ child: ChildRow } | YouthRefusal> {
  const mine = await guardianshipOf(guardianId, participantId, { live: true });
  if (!mine) return refuseYouth("YG_GUARDIAN");
  const row = (await getDb().prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(mine.participant.id)) as { linked_user_id: number | null } | undefined;
  if (!row || row.linked_user_id === null) return refuseYouth("YG_CHILD_NO_LOGIN");
  const level = (await getDb().prepare("SELECT messaging_authority FROM participant_guardians WHERE id = ?").get(mine.guardianship.id)) as { messaging_authority: AuthorityLevel } | undefined;
  if (!level || level.messaging_authority === "none") return refuseYouth("YG_NO_SAY");
  return { child: { participantId: mine.participant.id, displayName: mine.participant.displayName, minorId: row.linked_user_id, guardianshipId: mine.guardianship.id, authority: level.messaging_authority } };
}

type ConsentNotice = "on" | "off" | "restored";

/**
 * The child's other live guardians who have a say are told at once (the safeguarding notice kind), so no guardian is surprised: what they are told
 * is only that messaging for the child in the group is off and needs agreement from all guardians who decide, that it is on, or that agreement was
 * reached. Never who objected, never why (ADR 0049).
 */
async function tellOtherGuardians(child: ChildRow, exceptId: number, groupId: number, what: ConsentNotice): Promise<void> {
  try {
    const { emailPlayer } = await import("./outbox");
    const { baseUrl } = await import("./outbox");
    const { siteName } = await import("./site");
    const others = (await getDb()
      .prepare(
        "SELECT DISTINCT user_id FROM participant_guardians WHERE participant_id = ? AND user_id IS NOT NULL AND user_id <> ? AND revoked_at IS NULL AND suspended_at IS NULL AND archived_at IS NULL AND messaging_authority <> 'none'"
      )
      .all(child.participantId, exceptId)) as { user_id: number }[];
    const group = (await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
    const key = what === "off" ? "pmy.mail.consentOff" : what === "restored" ? "pmy.mail.consentRestored" : "pmy.mail.consentOn";
    for (const o of others)
      await emailPlayer({
        kind: "safeguarding_notice",
        venueId: null,
        userId: o.user_id,
        subject: (t) => t("pmy.mail.subject", { site: siteName() }),
        body: (t) => t(key, { child: shortName(child.displayName), group: group?.name ?? "" }),
        link: `${baseUrl()}/account`,
        dedupeKey: `pmy:consent:${groupId}:${child.minorId}:${o.user_id}:${what}:${Math.floor(Date.now() / 60_000)}`,
      });
  } catch (err) {
    console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
  }
}

/**
 * A guardian switches messaging on, or off, for one child in one youth group (docs/features/player-messages.md#supervised-youth-groups; ADR 0049).
 *
 * - **Off** (a guardian who decides, or who may object only): ends every consent for that child and group at once and opens an **objection**
 *   (once: another guardian's off while one is open is recorded and adds nothing). While it is open **no consent counts** unless every guardian who
 *   decides has agreed again, so another guardian switching it on records their consent and cannot reverse the restriction.
 * - **On** (a guardian who decides only; `objects_only` is refused): default off, takes the child to be a member of a marked group with their own
 *   login linked. With no objection open, one guardian's consent is enough, as before; with one open, it counts once all who decide have given theirs
 *   (the objector's own switch-on is their withdrawal of the objection), and the objection then closes.
 * - Everything is read and written under the child-and-group lock, the guardian's level and relationship re-read inside it, so two guardians changing
 *   consent at the same moment end consistently: an "on" never wins over a concurrent "off", whichever commits first.
 */
export async function setConsent(guardianId: number, participantId: unknown, groupId: number, on: boolean): Promise<Result<{ restored: boolean; needsAgreement: boolean }>> {
  const found = await guardianChild(guardianId, participantId);
  if ("ok" in found) return found;
  const { child } = found;
  if (on && child.authority === "objects_only") return refuseYouth("YG_OBJECTS_ONLY");
  const y = await youthGroupOf(groupId);
  if (!y || y.endedAt) return refuseYouth("YG_NOT_YOUTH");
  const member = await getDb().prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'member'").get(groupId, child.minorId);
  if (!member) return refuseYouth("YG_CHILD_NOT_IN");
  const result = await withTransaction(async (): Promise<Result<{ restored: boolean; needsAgreement: boolean }>> => {
    const db = getDb();
    await lockConsentState([groupId], child.minorId);
    // Re-read under the lock: the venue may have changed their level, or the relationship ended, since the first look.
    const again = await guardianChild(guardianId, participantId);
    if ("ok" in again) return again;
    const level = again.child.authority;
    if (on && level === "objects_only") return refuseYouth("YG_OBJECTS_ONLY");
    let restored = false;
    if (on) {
      await db
        .prepare("INSERT INTO youth_message_consents (group_id, minor_user_id, guardian_user_id, participant_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(groupId, child.minorId, guardianId, child.participantId);
      await youthEvent(groupId, "guardian", "consent_on", { actorId: guardianId, minorId: child.minorId, detail: `level ${level}` });
      restored = await settleObjection(groupId, child.minorId);
    } else {
      await recordSwitchOff(groupId, child.minorId, { userId: guardianId, participantId: child.participantId, level: level as "decides" | "objects_only" });
      await youthEvent(groupId, "guardian", "consent_off", { actorId: guardianId, minorId: child.minorId, detail: `level ${level}` });
    }
    return { ok: true as const, restored, needsAgreement: await needsAgreement(groupId, child.minorId) };
  });
  if (!result.ok) return result;
  if (!on) await tellOtherGuardians(child, guardianId, groupId, "off");
  else if (result.restored) await tellOtherGuardians(child, guardianId, groupId, "restored");
  else if (!result.needsAgreement) await tellOtherGuardians(child, guardianId, groupId, "on");
  return result;
}

/**
 * A guardian switches off messaging for a child in every group at once: every consent ends, the child's own opt-ins are taken back, and an
 * objection opens in each youth group the child is in (the same as a switch-off in each), all under the locks of those groups.
 */
export async function switchOffAll(guardianId: number, participantId: unknown): Promise<Result<{ groups: number }>> {
  const found = await guardianChild(guardianId, participantId);
  if ("ok" in found) return found;
  const { child } = found;
  return withTransaction(async (): Promise<Result<{ groups: number }>> => {
    const db = getDb();
    const consented = (await db.prepare("SELECT DISTINCT group_id FROM youth_message_consents WHERE minor_user_id = ? AND revoked_at IS NULL").all(child.minorId)) as { group_id: number }[];
    const inGroups = await youthGroupsOfMember(child.minorId);
    await lockConsentState([...inGroups, ...consented.map((c) => c.group_id)], child.minorId);
    const again = await guardianChild(guardianId, participantId);
    if ("ok" in again) return again;
    const live = (await db
      .prepare("UPDATE youth_message_consents SET revoked_at = datetime('now'), revoked_by = ? WHERE minor_user_id = ? AND revoked_at IS NULL RETURNING group_id")
      .all(guardianId, child.minorId)) as { group_id: number }[];
    await db.prepare("UPDATE youth_message_optins SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(child.minorId);
    for (const g of inGroups) await recordSwitchOff(g, child.minorId, { userId: guardianId, participantId: child.participantId, level: again.child.authority as "decides" | "objects_only" });
    for (const g of new Set(live.map((r) => r.group_id))) await youthEvent(g, "guardian", "consent_off_all", { actorId: guardianId, minorId: child.minorId, detail: `level ${again.child.authority}` });
    return { ok: true as const, groups: new Set(live.map((r) => r.group_id)).size };
  });
}

/** How often notices about this child's group messages are sent: the guardian's choice governs, whatever the child chose. */
export async function setGuardianNoticeMode(guardianId: number, participantId: unknown, mode: unknown): Promise<Result> {
  if (typeof mode !== "string" || !(NOTICE_MODES as readonly string[]).includes(mode)) return refuseYouth("YG_MODE");
  const found = await guardianChild(guardianId, participantId);
  if ("ok" in found) return found;
  await getDb()
    .prepare(
      `INSERT INTO youth_guardian_settings (minor_user_id, notice_mode, updated_by) VALUES (?, ?, ?)
       ON CONFLICT (minor_user_id) DO UPDATE SET notice_mode = excluded.notice_mode, updated_by = excluded.updated_by, updated_at = datetime('now')`
    )
    .run(found.child.minorId, mode, guardianId);
  return { ok: true as const };
}

/** The notice mode that governs notices about this minor's youth threads. */
export async function guardianNoticeMode(minorId: number): Promise<GuardianNoticeMode> {
  const r = (await getDb().prepare("SELECT notice_mode FROM youth_guardian_settings WHERE minor_user_id = ?").get(minorId)) as { notice_mode: GuardianNoticeMode } | undefined;
  return r?.notice_mode ?? "digest";
}

/**
 * A guardian blocks somebody for their child, in a youth group's thread the child is in: the same block as everywhere (nothing they write
 * reaches the child, nothing the child writes reaches them). Never a supervisor (a thread no supervisor can read is not supervised).
 */
export async function guardianBlock(guardianId: number, participantId: unknown, groupId: number, targetUserId: unknown): Promise<Result> {
  const found = await guardianChild(guardianId, participantId);
  if ("ok" in found) return found;
  if (!Number.isInteger(targetUserId)) return refuseYouth("YG_BLOCK_TARGET");
  const target = targetUserId as number;
  const y = await youthGroupOf(groupId);
  if (!y || y.endedAt) return refuseYouth("YG_NOT_YOUTH");
  const seats = await youthSeats(groupId);
  if (!seats.some((s) => s.userId === found.child.minorId) || !seats.some((s) => s.userId === target) || target === found.child.minorId) return refuseYouth("YG_BLOCK_TARGET");
  if (seats.find((s) => s.userId === target)?.role === "supervisor") return refuseYouth("PM_YOUTH_BLOCK_SUPERVISOR");
  await blockPlayer(found.child.minorId, target, { related: true });
  await youthEvent(groupId, "guardian", "blocked", { actorId: guardianId, minorId: found.child.minorId, detail: `person ${target}` });
  return { ok: true as const };
}

export interface GuardianChildView {
  participantId: number;
  displayName: string;
  /** The child's own login is linked: without one there is nothing to switch on. */
  hasLogin: boolean;
  noticeMode: GuardianNoticeMode;
  /** What the venue recorded this guardian may do about the child's messaging: `objects_only` may switch it off and never on. */
  authority: AuthorityLevel;
  groups: {
    groupId: number;
    name: string;
    supervisors: { name: string; declaredRole: DeclaredRole }[];
    /** The adults a supervisor let in, with what they said they are. */
    adults: { name: string; declaredRole: DeclaredRole }[];
    consentOn: boolean;
    /** This guardian has agreed (a live consent of their own). */
    myConsent: boolean;
    /** Messaging is off and needs agreement from all guardians who decide: all anybody is told of an objection (ADR 0049). */
    needsAgreement: boolean;
    childOptedIn: boolean;
    active: boolean;
    /** People this child has blocked in the group's thread (first names or short names), so a guardian sees what the child sees. */
    blocked: { userId: number; label: SeatLabel }[];
    /** People who could be blocked for the child here (supervisors excepted). */
    others: { userId: number; label: SeatLabel }[];
  }[];
}

/** For the guardian's "people I act for" page: for each person they manage, the youth groups the child's own login is in, and where each consent stands. */
export async function guardianOverview(guardianId: number): Promise<GuardianChildView[]> {
  const { guardianshipsOf } = await import("./participants");
  const db = getDb();
  const out: GuardianChildView[] = [];
  for (const { participant, guardianship } of await guardianshipsOf(guardianId)) {
    const row = (await db.prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(participant.id)) as { linked_user_id: number | null } | undefined;
    const minorId = row?.linked_user_id ?? null;
    if (minorId === null) continue;
    // A guardian the venue recorded as having no say in messaging is shown nothing of it.
    const level = (await db.prepare("SELECT messaging_authority FROM participant_guardians WHERE id = ?").get(guardianship.id)) as { messaging_authority: AuthorityLevel } | undefined;
    if (!level || level.messaging_authority === "none") continue;
    const groups = (await db
      .prepare(
        `SELECT g.id, g.name FROM group_members m JOIN community_groups g ON g.id = m.group_id JOIN youth_groups y ON y.group_id = g.id AND y.ended_at IS NULL
          WHERE m.user_id = ? AND m.status = 'member' ORDER BY g.id`
      )
      .all(minorId)) as { id: number; name: string }[];
    const view: GuardianChildView = { participantId: participant.id, displayName: participant.displayName, hasLogin: true, noticeMode: await guardianNoticeMode(minorId), authority: level.messaging_authority, groups: [] };
    for (const g of groups) {
      const adults = (await db
        .prepare(`SELECT u.name, a.role, a.declared_role FROM youth_group_adults a JOIN users u ON u.id = a.user_id WHERE a.group_id = ? AND a.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM youth_thread_mutes pm WHERE pm.group_id = a.group_id AND pm.user_id = a.user_id AND pm.lifted_at IS NULL) ORDER BY a.id`)
        .all(g.id)) as { name: string; role: "supervisor" | "adult"; declared_role: DeclaredRole }[];
      const seats = await youthSeats(g.id);
      const blockedRows = (await db.prepare("SELECT blocked_id FROM player_blocks WHERE blocker_id = ?").all(minorId)) as { blocked_id: number }[];
      const blockedIds = new Set(blockedRows.map((b) => b.blocked_id));
      view.groups.push({
        groupId: g.id,
        name: g.name,
        supervisors: adults.filter((a) => a.role === "supervisor").map((a) => ({ name: firstName(a.name), declaredRole: a.declared_role })),
        adults: adults.filter((a) => a.role === "adult").map((a) => ({ name: firstName(a.name), declaredRole: a.declared_role })),
        consentOn: await guardianConsentLive(g.id, minorId),
        myConsent: Boolean(await db.prepare("SELECT 1 FROM youth_message_consents WHERE group_id = ? AND minor_user_id = ? AND guardian_user_id = ? AND revoked_at IS NULL").get(g.id, minorId, guardianId)),
        needsAgreement: await needsAgreement(g.id, minorId),
        childOptedIn: Boolean(await db.prepare("SELECT 1 FROM youth_message_optins WHERE group_id = ? AND user_id = ? AND revoked_at IS NULL").get(g.id, minorId)),
        active: seats.some((s) => s.userId === minorId),
        blocked: seats.filter((s) => blockedIds.has(s.userId)).map((s) => ({ userId: s.userId, label: s.from })),
        others: seats.filter((s) => s.userId !== minorId && s.role !== "supervisor" && !s.restricted && !blockedIds.has(s.userId)).map((s) => ({ userId: s.userId, label: s.from })),
      });
    }
    out.push(view);
  }
  return out;
}

// ------------------------------------------------------------------ the supervisor

async function supervisedThread(userId: number, groupId: number): Promise<{ threadId: number } | YouthRefusal> {
  const y = await youthGroupOf(groupId);
  if (!y) return refuseYouth("YG_NOT_FOUND");
  if (y.endedAt) return refuseYouth("YG_ENDED");
  if (!(await isSupervisor(userId, groupId))) return refuseYouth("YG_SUPERVISOR");
  const t = (await getDb().prepare("SELECT id FROM player_message_threads WHERE context_kind = 'group' AND context_id = ? AND youth = 1").get(groupId)) as { id: number } | undefined;
  return t ? { threadId: t.id } : refuseYouth("YG_TARGET");
}

/** A supervisor removes a message from the thread: not shown to members or guardians; kept for staff review until YOUTH_REMOVED_RETENTION_DAYS. */
export async function removeMessage(userId: number, groupId: number, messageId: unknown, reasonRaw: unknown): Promise<Result> {
  const reason = clean(reasonRaw);
  if (!reason) return refuseYouth("YG_REASON");
  const s = await supervisedThread(userId, groupId);
  if ("ok" in s) return s;
  if (!Number.isInteger(messageId)) return refuseYouth("YG_TARGET");
  const by = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string } | undefined;
  const done = await getDb()
    .prepare("UPDATE player_messages SET hidden_at = datetime('now'), hidden_by = ? WHERE id = ? AND thread_id = ? AND hidden_at IS NULL AND body IS NOT NULL")
    .run(`supervisor ${firstName(by?.name ?? "")}`, messageId, s.threadId);
  if (done.changes === 0) return refuseYouth("YG_TARGET");
  await youthEvent(groupId, "supervisor", "message_removed", { actorId: userId, detail: `message ${messageId}: ${reason}` });
  const sender = (await getDb().prepare("SELECT sender_id FROM player_messages WHERE id = ?").get(messageId)) as { sender_id: number | null } | undefined;
  if (sender?.sender_id) await (await import("./youth-safeguarding")).tellGuardiansModerated(sender.sender_id, groupId, "removed").catch(() => undefined);
  return { ok: true as const };
}

/** A supervisor mutes the sender of a message in this thread: they can read, not write, until a supervisor lifts it. Never the supervisors themselves. */
export async function muteSender(userId: number, groupId: number, messageId: unknown, reasonRaw: unknown): Promise<Result> {
  const reason = clean(reasonRaw);
  if (!reason) return refuseYouth("YG_REASON");
  const s = await supervisedThread(userId, groupId);
  if ("ok" in s) return s;
  if (!Number.isInteger(messageId)) return refuseYouth("YG_TARGET");
  const db = getDb();
  const m = (await db.prepare("SELECT sender_id FROM player_messages WHERE id = ? AND thread_id = ?").get(messageId, s.threadId)) as { sender_id: number | null } | undefined;
  if (!m || m.sender_id === null || m.sender_id === userId) return refuseYouth("YG_TARGET");
  if (await isSupervisor(m.sender_id, groupId)) return refuseYouth("YG_SUPERVISOR");
  const by = (await db.prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string } | undefined;
  await db
    .prepare("INSERT INTO youth_thread_mutes (group_id, user_id, source, reason, muted_by) VALUES (?, ?, 'supervisor', ?, ?) ON CONFLICT DO NOTHING")
    .run(groupId, m.sender_id, reason, `supervisor ${firstName(by?.name ?? "")}`);
  await youthEvent(groupId, "supervisor", "muted", { actorId: userId, detail: `person ${m.sender_id}: ${reason}` });
  await (await import("./youth-safeguarding")).tellGuardiansModerated(m.sender_id, groupId, "muted").catch(() => undefined);
  return { ok: true as const };
}

/** A supervisor lifts a mute a supervisor set. (One placed by a report waits for the report's review.) */
export async function unmute(userId: number, groupId: number, muteId: unknown): Promise<Result> {
  const s = await supervisedThread(userId, groupId);
  if ("ok" in s) return s;
  if (!Number.isInteger(muteId)) return refuseYouth("YG_TARGET");
  const by = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string } | undefined;
  const done = await getDb()
    .prepare("UPDATE youth_thread_mutes SET lifted_at = datetime('now'), lifted_by = ? WHERE id = ? AND group_id = ? AND lifted_at IS NULL AND source = 'supervisor'")
    .run(`supervisor ${firstName(by?.name ?? "")}`, muteId, groupId);
  if (done.changes === 0) return refuseYouth("YG_TARGET");
  await youthEvent(groupId, "supervisor", "unmuted", { actorId: userId, detail: `mute ${muteId}` });
  return { ok: true as const };
}

/** A supervisor pauses the thread, opens it again, or closes it for good. A thread staff closed stays closed. */
export async function setSupervisedThreadState(userId: number, groupId: number, state: unknown, reasonRaw: unknown): Promise<Result<{ state: "open" | "muted" | "closed" }>> {
  const reason = clean(reasonRaw);
  if (!reason) return refuseYouth("YG_REASON");
  if (state !== "open" && state !== "muted" && state !== "closed") return refuseYouth("YG_MODE");
  const s = await supervisedThread(userId, groupId);
  if ("ok" in s) return s;
  const by = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string } | undefined;
  const done = await getDb()
    .prepare("UPDATE player_message_threads SET staff_state = ?, staff_reason = ?, staff_admin_name = ?, staff_at = datetime('now') WHERE id = ? AND staff_state <> 'closed'")
    .run(state, reason, `supervisor ${firstName(by?.name ?? "")}`, s.threadId);
  if (done.changes === 0) return refuseYouth("YG_ENDED");
  await youthEvent(groupId, "supervisor", `thread_${state}`, { actorId: userId, detail: reason });
  // Urgent: a conversation closed is told at once to its supervisors and the minors' guardians (lib/youth-safeguarding.ts).
  if (state === "closed") await (await import("./youth-safeguarding")).tellThreadClosed(groupId).catch(() => undefined);
  return { ok: true as const, state };
}

/** Whether this person is muted in the group's thread now (a supervisor's mute, or one a report placed). */
export async function mutedInThread(groupId: number, userId: number): Promise<boolean> {
  return Boolean(await getDb().prepare("SELECT 1 FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL").get(groupId, userId));
}

/** Whether this account is a member of a community group marked as a supervised youth group: the only messaging an account that is not declared 18 or over can have. */
export async function inYouthGroup(userId: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare("SELECT 1 FROM group_members m JOIN youth_groups y ON y.group_id = m.group_id AND y.ended_at IS NULL WHERE m.user_id = ? AND m.status = 'member' LIMIT 1")
      .get(userId)
  );
}

