import { getDb, withTransaction } from "./db";
import { inSameBusiness } from "./branches";
import { logAction } from "./activity";
import { refuse } from "./entitlements";
import { translator } from "./i18n";
import type { Phrase } from "./i18n";
import { accountLocale, baseUrl, enqueue } from "./outbox";
import { addDays, isValidDateString, todayISO } from "./time";
import type { Refusal } from "./types";

/**
 * Suspending a membership, and reactivating it (the owner's decision of
 * 28 October 2026; docs/features/pricing.md#suspending-a-membership).
 *
 * A manager suspends a membership with a reason, from a date (today or later)
 * until a date or until it is reactivated. Each suspension is a row of its
 * own (`membership_suspensions`, migration 0216), never overwritten: who,
 * when, why, and who lifted it early, when and why.
 *
 * - **What it does.** On a date inside a suspension the membership covers
 *   nobody: not its holder, not a participant whose own it is, not a
 *   dependant a family membership names (all of them together; nobody is
 *   split off). `activeMembership` and `participantMembership` (lib/store.ts)
 *   leave it out, so everything built on them follows, for the date asked:
 *   member prices, the members' window, members-only places, check-in and
 *   the door (lib/entitlements.ts `memberCover`, `participationLapses`).
 * - **Bookings already made** for its dates are never cancelled or refunded:
 *   they are flagged for staff (lib/membership-flags.ts, reason
 *   `suspended`), as a cancelled membership's are.
 * - **Reactivating** lifts it from today; a dated one also ends by itself
 *   after its last day. Flags it raised stay for staff to decide: flags are
 *   not resolved by themselves on a renewal either.
 * - **Its end does not move**, unless the membership's plan says so
 *   (`membership_plans.extend_on_suspension`, migration 0218, off unless set):
 *   then the days the suspension takes out of the term are added to the end
 *   once its last day is known (when suspended with an until date, or when
 *   lifted), recorded on the suspension and in the activity log, corrected
 *   (never added twice) when it is lifted early.
 * - **A renewal** (a later term of the same holder, however it is bought, a
 *   subscription's charge included) is still charged and made on its date;
 *   a suspension in force when it starts is carried on to it, so a renewal
 *   never lifts a suspension silently. Lifting one lifts the chain.
 * - **An open-ended suspension of a membership that renews by itself** always
 *   extends its end by the days it took, whatever its plan says (ADR 0062):
 *   nothing here can hold the gateway's charge, so a member who is charged
 *   while suspended is given those days back when it is lifted, the days of
 *   every term of the chain added to the last term's end (`carriedDays`).
 * - **The holder is told** by email through the outbox, in their language,
 *   with the dates: the account that holds or bought it. Nobody it covers is
 *   written to, and no account that has said it is under 18.
 */

export interface SuspensionRow {
  id: number;
  membership_id: number;
  venue_id: number;
  starts_on: string;
  until_on: string | null;
  ends_on: string | null;
  reason: string;
  by_name: string;
  created_at: unknown;
  lifted_at: unknown;
  lifted_by: string | null;
  lift_reason: string | null;
  carried_from: number | null;
  chain_id: number | null;
  extends_expiry: boolean;
  extended_days: number;
  extension_note: string | null;
}

/** A suspension as staff see it in a membership's history. */
export interface SuspensionView {
  id: number;
  from: string;
  /** The last day as set; null: until reactivated. */
  until: string | null;
  /** The last day it applies: `until`, or the day before it was lifted; null while open-ended. */
  endsOn: string | null;
  reason: string;
  by: string;
  at: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftReason: string | null;
  /** Days added to the membership's end for it (its plan's setting). */
  extendedDays: number;
  /** Why the end was not moved, where it could not be. */
  extensionNote: string | null;
  /** Carried on from the holder's previous term. */
  carried: boolean;
}

/** Longest reason kept. */
export const MAX_SUSPENSION_REASON = 300;

/**
 * SQL: the membership `alias` is suspended on a date, given twice as
 * parameters (`starts_on <= ?` and `ends_on >= ?`).
 */
export function suspendedOn(alias = "m"): string {
  return `EXISTS (SELECT 1 FROM membership_suspensions s WHERE s.membership_id = ${alias}.id AND s.starts_on <= ? AND (s.ends_on IS NULL OR s.ends_on >= ?))`;
}

const isoOf = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

const toView = (r: SuspensionRow): SuspensionView => ({
  id: r.id,
  from: r.starts_on,
  until: r.until_on,
  endsOn: r.ends_on,
  reason: r.reason,
  by: r.by_name,
  at: isoOf(r.created_at) ?? "",
  liftedAt: isoOf(r.lifted_at),
  liftedBy: r.lifted_by,
  liftReason: r.lift_reason,
  extendedDays: Number(r.extended_days),
  extensionNote: r.extension_note,
  carried: r.carried_from !== null,
});

/** Every suspension of a membership, oldest first. */
export async function suspensionHistory(membershipId: number): Promise<SuspensionView[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM membership_suspensions WHERE membership_id = ? ORDER BY starts_on, id")
    .all(membershipId)) as SuspensionRow[];
  return rows.map(toView);
}

/** The suspension this membership is in on a date, if any. */
export async function suspensionOn(membershipId: number, date: string): Promise<SuspensionView | null> {
  const row = (await getDb()
    .prepare("SELECT * FROM membership_suspensions WHERE membership_id = ? AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?) ORDER BY id LIMIT 1")
    .get(membershipId, date, date)) as SuspensionRow | undefined;
  return row ? toView(row) : null;
}

/** Days from one ISO date to another (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}

interface MembershipRow {
  id: number;
  code: string;
  venue_id: number;
  venue_name: string;
  user_id: number | null;
  holder_kind: "customer" | "participant";
  holder_phone: string;
  holder_name: string;
  holder_participant_id: number | null;
  status: string;
  starts_on: string;
  expires_on: string;
  plan: number | null;
}

const MEMBERSHIP_COLUMNS = `m.id, m.code, m.venue_id, v.name AS venue_name, m.user_id, m.holder_kind, m.holder_phone, m.holder_name,
  m.holder_participant_id, m.status, m.starts_on, m.expires_on, COALESCE(m.tier_id, m.plan_id) AS plan`;

async function lockedMembership(id: number): Promise<MembershipRow | undefined> {
  return (await getDb()
    .prepare(`SELECT ${MEMBERSHIP_COLUMNS} FROM memberships m JOIN venues v ON v.id = m.venue_id WHERE m.id = ? FOR UPDATE OF m`)
    .get(id)) as MembershipRow | undefined;
}

/** The people a membership covers: its participant holder, and the dependants it names. */
async function coveredPeople(m: MembershipRow): Promise<number[]> {
  const named = (await getDb().prepare("SELECT participant_id FROM membership_participants WHERE membership_id = ? ORDER BY participant_id").all(m.id)) as {
    participant_id: number;
  }[];
  return [...(m.holder_kind === "participant" && m.holder_participant_id !== null ? [m.holder_participant_id] : []), ...named.map((r) => r.participant_id)];
}

/**
 * Another live membership that moving this one's end to `until` would run
 * into: the same holder's next term, or one holding or covering somebody
 * this one covers, starting after its present end and on or before `until`.
 */
async function laterTerm(m: MembershipRow, until: string): Promise<{ code: string; starts_on: string } | null> {
  const people = await coveredPeople(m);
  const holder =
    m.holder_kind === "participant"
      ? "o.holder_participant_id = ?"
      : "(o.holder_kind = 'customer' AND phone_key(o.holder_phone) = phone_key(?))";
  const marks = people.map(() => "?").join(", ");
  const sharing =
    people.length > 0
      ? ` OR o.holder_participant_id IN (${marks}) OR EXISTS (SELECT 1 FROM membership_participants op WHERE op.membership_id = o.id AND op.participant_id IN (${marks}))`
      : "";
  return ((await getDb()
    .prepare(
      `SELECT o.code, o.starts_on FROM memberships o WHERE ${inSameBusiness("o.venue_id")} AND o.id <> ? AND o.status = 'active'
          AND o.starts_on > ? AND o.starts_on <= ? AND (${holder}${sharing}) ORDER BY o.starts_on LIMIT 1`
    )
    .get(m.venue_id, m.id, m.expires_on, until, m.holder_kind === "participant" ? m.holder_participant_id : m.holder_phone, ...people, ...people)) ?? null) as {
    code: string;
    starts_on: string;
  } | null;
}

/**
 * The next term that moving a membership's end to `until` would run into (the
 * holder's next term, or one holding or covering somebody this one covers), or
 * null. For giving days back (lib/store.ts `extendMembership`), which refuses
 * what a suspension's extension already refuses (ADR 0062): two live terms for
 * the same days. Under the membership's row lock.
 */
export async function termAfter(membershipId: number, until: string): Promise<{ code: string; startsOn: string } | null> {
  const m = await lockedMembership(membershipId);
  if (!m) return null;
  const later = await laterTerm(m, until);
  return later ? { code: later.code, startsOn: later.starts_on } : null;
}

/**
 * Does a subscription still charge for this membership's next term: does it
 * renew by itself? (`membership_subscriptions.membership_id` is the term its
 * latest charge made.)
 */
export async function renewsByItself(membershipId: number): Promise<boolean> {
  return !!(await getDb().prepare("SELECT 1 FROM membership_subscriptions WHERE membership_id = ? AND status = 'active'").get(membershipId));
}

/** Days from `from` to `to`, both ends counted; 0 when `to` is before `from`. */
const spanDays = (from: string, to: string): number => (to < from ? 0 : daysBetween(from, to) + 1);

/**
 * Days that earlier terms of this suspension's chain took out of them and
 * could not take back in their own end, because a renewal of the chain follows
 * them (their extension note says `Carried to`): added to the end of the
 * chain's last term, so a renewal charged while suspended is not charged for
 * nothing (ADR 0062). Zero for a suspension that has no such predecessors.
 */
async function carriedDays(s: SuspensionRow, termStart: string): Promise<number> {
  const rows = (await getDb()
    .prepare(
      `SELECT x.starts_on, x.ends_on, x.extended_days, m.starts_on AS term_from, m.expires_on AS term_to
         FROM membership_suspensions x JOIN memberships m ON m.id = x.membership_id
        WHERE COALESCE(x.chain_id, x.id) = ? AND x.id <> ? AND x.extends_expiry AND x.ends_on IS NOT NULL
          AND x.extension_note LIKE 'Carried to %' AND m.status = 'active' AND m.starts_on < ?`
    )
    .all(s.chain_id ?? s.id, s.id, termStart)) as { starts_on: string; ends_on: string; extended_days: number; term_from: string; term_to: string }[];
  let n = 0;
  for (const r of rows) {
    const from = r.starts_on > r.term_from ? r.starts_on : r.term_from;
    const to = r.ends_on < r.term_to ? r.ends_on : r.term_to;
    n += Math.max(0, spanDays(from, to) - Number(r.extended_days));
  }
  return n;
}

/** Is this term one a suspension of the same chain was carried on to? */
async function inChain(s: SuspensionRow, code: string): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM membership_suspensions c JOIN memberships o ON o.id = c.membership_id
        WHERE COALESCE(c.chain_id, c.id) = ? AND c.id <> ? AND o.code = ? LIMIT 1`
    )
    .get(s.chain_id ?? s.id, s.id, code));
}

/**
 * Bring a suspension's extension of the membership's end up to date: the
 * days it takes out of the term (as the term is without this extension),
 * once its last day is known. Applied once; lifted early, corrected down.
 * Never run into a later term: then the end stays, with why. Returns the
 * days the end moved by (0 when it did not).
 *
 * Where the later term is a renewal this suspension was carried on to (its own
 * chain), the days are not lost: they are left to the chain's last term, whose
 * end takes them with its own (`carriedDays`).
 */
async function settleExtension(s: SuspensionRow): Promise<{ moved: number; until: string | null; blockedBy: string | null }> {
  if (!s.extends_expiry || s.ends_on === null) return { moved: 0, until: null, blockedBy: null };
  const db = getDb();
  const m = await lockedMembership(s.membership_id);
  if (!m || m.status !== "active") return { moved: 0, until: null, blockedBy: null };
  const termEnds = addDays(m.expires_on, -Number(s.extended_days));
  const from = s.starts_on > m.starts_on ? s.starts_on : m.starts_on;
  const to = s.ends_on < termEnds ? s.ends_on : termEnds;
  const own = spanDays(from, to);
  const ownDelta = own - Number(s.extended_days);
  if (ownDelta > 0) {
    const next = await laterTerm(m, addDays(m.expires_on, ownDelta));
    if (next && (await inChain(s, next.code))) {
      // The renewal it was carried on to is the last term's to extend: this one keeps its end, and says where its days went.
      await db.prepare("UPDATE membership_suspensions SET extension_note = ? WHERE id = ?").run(`Carried to ${next.code}: its end takes these days.`, s.id);
      return { moved: 0, until: null, blockedBy: null };
    }
  }
  const days = own + (await carriedDays(s, m.starts_on));
  const delta = days - Number(s.extended_days);
  if (delta === 0) return { moved: 0, until: null, blockedBy: null };
  const until = addDays(m.expires_on, delta);
  if (delta > 0) {
    const later = await laterTerm(m, until);
    if (later) {
      await db.prepare("UPDATE membership_suspensions SET extension_note = ? WHERE id = ?").run(`Not moved: ${later.code} starts by ${until}.`, s.id);
      return { moved: 0, until: null, blockedBy: later.code };
    }
  }
  await db.prepare("UPDATE memberships SET expires_on = ? WHERE id = ?").run(until, m.id);
  await db.prepare("UPDATE membership_suspensions SET extended_days = ?, extension_note = NULL WHERE id = ?").run(days, s.id);
  return { moved: delta, until, blockedBy: null };
}

/** Does this membership's plan extend its end by the time suspended? */
async function planExtends(planId: number | null): Promise<boolean> {
  if (planId === null) return false;
  const row = (await getDb().prepare("SELECT extend_on_suspension FROM membership_plans WHERE id = ?").get(planId)) as { extend_on_suspension: boolean | number } | undefined;
  return row?.extend_on_suspension === true || row?.extend_on_suspension === 1;
}

type Staff = { id: number | null; name: string };

export type SuspendResult =
  | { ok: true; suspension: SuspensionView; flagged: number; expiresOn: string; extension: { moved: number; blockedBy: string | null } }
  | (Refusal & { status: number });

const refused = (status: number, ...args: Parameters<typeof refuse>) => ({ ...refuse(...args), status });

/**
 * Suspend a membership (a manager): `{ from, until?, reason }`. From today
 * or later, and before it ends; `until` on or after `from`, or left out for
 * until reactivated. Refused where it would overlap another suspension of
 * it. Bookings already made for its dates are flagged, the holder emailed,
 * and it is in the activity log.
 */
export async function suspendMembership(admin: Staff, membershipId: number, input: { from?: unknown; until?: unknown; reason?: unknown }): Promise<SuspendResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_SUSPENSION_REASON) : "";
  if (reason.length < 3) return refused(400, "MS7_REASON");
  const from = typeof input.from === "string" ? input.from : "";
  const until = input.until === undefined || input.until === null || input.until === "" ? null : typeof input.until === "string" ? input.until : "";
  if (!isValidDateString(from) || (until !== null && !isValidDateString(until))) return refused(400, "MS7_DATES");
  const today = todayISO();
  if (from < today) return refused(400, "MS7_FROM_PAST", { today });
  if (until !== null && until < from) return refused(400, "MS7_DATES");
  const done = await withTransaction(async (): Promise<SuspendResult> => {
    const db = getDb();
    const m = await lockedMembership(membershipId);
    if (!m) return refused(404, "MS7_NOT_FOUND");
    if (m.status !== "active" || m.expires_on < today) return refused(409, "MS7_NOT_ACTIVE");
    if (from > m.expires_on) return refused(409, "MS7_AFTER_END", { until: m.expires_on });
    const clash = (await db
      .prepare(
        `SELECT starts_on, ends_on FROM membership_suspensions
          WHERE membership_id = ? AND (ends_on IS NULL OR ends_on >= starts_on)
            AND (ends_on IS NULL OR ends_on >= ?) AND (?::text IS NULL OR starts_on <= ?::text) LIMIT 1`
      )
      .get(m.id, from, until, until)) as { starts_on: string; ends_on: string | null } | undefined;
    if (clash) return refused(409, clash.ends_on ? "MS7_OVERLAP" : "MS7_OVERLAP_OPEN", { from: clash.starts_on, until: clash.ends_on ?? "" });
    // Open-ended and renewing by itself: the gateway keeps charging, so the days it takes are given back whatever the plan says.
    const renews = until === null && (await renewsByItself(m.id));
    const extendsExpiry = (await planExtends(m.plan)) || renews;
    const info = await db
      .prepare(
        `INSERT INTO membership_suspensions (membership_id, venue_id, starts_on, until_on, ends_on, reason, by_admin_id, by_name, extends_expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.id, m.venue_id, from, until, until, reason, admin.id, admin.name, extendsExpiry);
    const id = Number(info.lastInsertRowid);
    await db.prepare("UPDATE membership_suspensions SET chain_id = id WHERE id = ?").run(id);
    const row = (await db.prepare("SELECT * FROM membership_suspensions WHERE id = ?").get(id)) as SuspensionRow;
    // A dated one's length is known now: its plan's extension, where it has one, is applied at once.
    const extension = await settleExtension(row);
    // Bookings already made for its dates: flagged for staff, never cancelled or refunded.
    const { flagAfterMembershipLoss } = await import("./membership-flags");
    const flagged = await flagAfterMembershipLoss(m.id, "suspended", undefined, id);
    const after = (await lockedMembership(m.id))!;
    const { participantEvent } = await import("./participants");
    for (const p of await coveredPeople(m))
      await participantEvent(p, "membership.suspended", { adminId: admin.id, name: admin.name }, {
        venueId: m.venue_id,
        detail: `${m.code}: suspended from ${from} ${until ? `until ${until}` : "until reactivated"}`,
      });
    await logAction(admin, {
      venueId: m.venue_id,
      action: "membership.suspended",
      detail: `${m.code}: from ${from} ${until ? `until ${until}` : "until reactivated"}${flagged > 0 ? `; ${flagged} booking(s) flagged for staff` : ""}${
        extension.moved !== 0 ? `; its end moved to ${after.expires_on} (${extension.moved} days, its plan's setting)` : ""
      }${extension.blockedBy ? `; its end not moved: ${extension.blockedBy} follows it` : ""}${
        renews ? "; it renews by itself and is still charged while suspended, so the days it is suspended are added to its end when it is lifted" : ""
      }. Reason: ${reason}`,
    });
    await notifyHolder(after, { kind: "suspended", from, until, reason, movedTo: extension.moved !== 0 ? after.expires_on : null });
    return {
      ok: true,
      suspension: toView((await db.prepare("SELECT * FROM membership_suspensions WHERE id = ?").get(id)) as SuspensionRow),
      flagged,
      expiresOn: after.expires_on,
      extension: { moved: extension.moved, blockedBy: extension.blockedBy },
    };
  });
  return done;
}

export type ReactivateResult =
  | { ok: true; lifted: SuspensionView[]; expiresOn: string; extension: { moved: number; blockedBy: string | null } }
  | (Refusal & { status: number });

/**
 * Reactivate a suspended membership (a manager), with the reason: every
 * suspension of it in force today or later is lifted from today, with the
 * rest of its chain (one carried on to a renewal, or from the term before).
 * History is kept: the rows say when and by whom it was lifted. Flags it
 * raised stay for staff to decide. A plan that extends by the time
 * suspended has its extension corrected to the days actually suspended.
 */
export async function reactivateMembership(admin: Staff, membershipId: number, input: { reason?: unknown }): Promise<ReactivateResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_SUSPENSION_REASON) : "";
  if (reason.length < 3) return refused(400, "MS7_REASON");
  const today = todayISO();
  return withTransaction(async (): Promise<ReactivateResult> => {
    const db = getDb();
    const m = await lockedMembership(membershipId);
    if (!m) return refused(404, "MS7_NOT_FOUND");
    const live = (await db
      .prepare("SELECT * FROM membership_suspensions WHERE membership_id = ? AND lifted_at IS NULL AND (ends_on IS NULL OR ends_on >= ?) AND (ends_on IS NULL OR ends_on >= starts_on)")
      .all(m.id, today)) as SuspensionRow[];
    if (live.length === 0) return refused(409, "MS7_NOT_SUSPENDED");
    const chains = [...new Set(live.map((s) => s.chain_id ?? s.id))];
    const marks = chains.map(() => "?").join(", ");
    const rows = (await db
      .prepare(
        `SELECT * FROM membership_suspensions WHERE COALESCE(chain_id, id) IN (${marks}) AND lifted_at IS NULL AND (ends_on IS NULL OR ends_on >= ?) ORDER BY id`
      )
      .all(...chains, today)) as SuspensionRow[];
    const lastDay = addDays(today, -1);
    let moved = 0;
    let blockedBy: string | null = null;
    for (const s of rows) {
      await db
        .prepare(
          `UPDATE membership_suspensions SET ends_on = ?, lifted_at = now(), lifted_by_admin_id = ?, lifted_by = ?, lift_reason = ? WHERE id = ?`
        )
        .run(lastDay, admin.id, admin.name, reason, s.id);
      const settled = await settleExtension({ ...s, ends_on: lastDay });
      if (s.membership_id === m.id) {
        moved += settled.moved;
        blockedBy = blockedBy ?? settled.blockedBy;
      }
    }
    const after = (await lockedMembership(m.id))!;
    const { participantEvent } = await import("./participants");
    for (const p of await coveredPeople(m))
      await participantEvent(p, "membership.reactivated", { adminId: admin.id, name: admin.name }, { venueId: m.venue_id, detail: `${m.code}: active again from ${today}` });
    await logAction(admin, {
      venueId: m.venue_id,
      action: "membership.reactivated",
      detail: `${m.code}: active again from ${today}${moved !== 0 ? `; its end moved to ${after.expires_on} (${moved > 0 ? "+" : ""}${moved} days, its plan's setting)` : ""}${
        blockedBy ? `; its end not moved: ${blockedBy} follows it` : ""
      }. Reason: ${reason}`,
    });
    await notifyHolder(after, { kind: "reactivated", from: today, until: null, reason, movedTo: null });
    const lifted = (await db
      .prepare(`SELECT * FROM membership_suspensions WHERE id IN (${rows.map(() => "?").join(", ")}) ORDER BY id`)
      .all(...rows.map((r) => r.id))) as SuspensionRow[];
    return { ok: true, lifted: lifted.map(toView), expiresOn: after.expires_on, extension: { moved, blockedBy } };
  });
}

/**
 * A new term for a holder (a renewal, at the counter or online, or a
 * subscription's charge): a suspension of the same holder's earlier term in
 * force on the day the new one starts is carried on to it, from that day to
 * the same end, so a renewal never lifts it silently. Called as the new
 * membership is made, in its transaction. Returns how many were carried.
 */
export async function carrySuspensions(membershipId: number): Promise<number> {
  const db = getDb();
  const m = (await db.prepare(`SELECT ${MEMBERSHIP_COLUMNS} FROM memberships m JOIN venues v ON v.id = m.venue_id WHERE m.id = ?`).get(membershipId)) as
    | MembershipRow
    | undefined;
  if (!m) return 0;
  const holder =
    m.holder_kind === "participant" ? "o.holder_kind = 'participant' AND o.holder_participant_id = ?" : "o.holder_kind = 'customer' AND phone_key(o.holder_phone) = phone_key(?)";
  const carried = (await db
    .prepare(
      `SELECT s.* FROM membership_suspensions s JOIN memberships o ON o.id = s.membership_id
        WHERE ${inSameBusiness("o.venue_id")} AND o.id <> ? AND o.status = 'active' AND o.starts_on < ? AND ${holder}
          AND s.starts_on <= ? AND (s.ends_on IS NULL OR s.ends_on >= ?) AND (s.ends_on IS NULL OR s.ends_on >= s.starts_on)
          AND NOT EXISTS (SELECT 1 FROM membership_suspensions c WHERE c.carried_from = s.id)
        ORDER BY s.id`
    )
    .all(m.venue_id, m.id, m.starts_on, m.holder_kind === "participant" ? m.holder_participant_id : m.holder_phone, m.expires_on, m.starts_on)) as SuspensionRow[];
  if (carried.length === 0) return 0;
  const planExtendsEnd = await planExtends(m.plan);
  let n = 0;
  for (const s of carried) {
    // An open-ended one that extends (its plan's setting, or the holder renewing by itself) goes on extending in the renewal.
    const extendsExpiry = planExtendsEnd || (s.ends_on === null && s.extends_expiry);
    const from = s.starts_on > m.starts_on ? s.starts_on : m.starts_on;
    const info = await db
      .prepare(
        `INSERT INTO membership_suspensions (membership_id, venue_id, starts_on, until_on, ends_on, reason, by_admin_id, by_name, carried_from, chain_id, extends_expiry)
         SELECT ?, ?, ?, until_on, ends_on, reason, by_admin_id, by_name, id, COALESCE(chain_id, id), ? FROM membership_suspensions WHERE id = ?
         ON CONFLICT DO NOTHING`
      )
      .run(m.id, m.venue_id, from, extendsExpiry, s.id);
    if (info.changes === 0) continue;
    n++;
    const row = (await db.prepare("SELECT * FROM membership_suspensions WHERE id = ?").get(Number(info.lastInsertRowid))) as SuspensionRow;
    await settleExtension(row);
    await logAction(
      { id: null, name: "MySenam" },
      {
        venueId: m.venue_id,
        action: "membership.suspended",
        detail: `${m.code}: carried on from the term before, from ${from} ${s.ends_on ? `until ${s.ends_on}` : "until reactivated"}. Reason: ${s.reason}`,
      }
    );
  }
  return n;
}

/**
 * Tell the holder: the account that holds or bought the membership, in the
 * language it last used, through the outbox. Nobody it covers is written to
 * (a child has no address here), nor an account that said it is under 18;
 * one sold at the counter with no account is told by the venue.
 */
async function notifyHolder(
  m: MembershipRow,
  what: { kind: "suspended" | "reactivated"; from: string; until: string | null; reason: string; movedTo: string | null }
): Promise<boolean> {
  if (m.user_id === null) return false;
  const db = getDb();
  const user = (await db.prepare("SELECT name, email FROM users WHERE id = ?").get(m.user_id)) as { name: string; email: string | null } | undefined;
  if (!user?.email) return false;
  const { declaredAdult } = await import("./player-profiles");
  if ((await declaredAdult(m.user_id)) === false) return false;
  const { siteName } = await import("./site");
  const { linkIn } = await import("./link-locale");
  const locale = await accountLocale(m.user_id);
  const t = translator(locale, siteName());
  const vars = { venue: m.venue_name, code: m.code, from: what.from, until: what.until ?? "", reason: what.reason, date: what.movedTo ?? "", end: m.expires_on };
  const subject: Phrase = what.kind === "suspended" ? "ms7.mail.suspendedSubject" : "ms7.mail.reactivatedSubject";
  const body: Phrase[] =
    what.kind === "suspended"
      ? [what.until ? "ms7.mail.suspended" : "ms7.mail.suspendedOpen", ...(what.movedTo ? (["ms7.mail.endMoves"] as Phrase[]) : []), "ms7.mail.bookings", "ms7.mail.reason"]
      : ["ms7.mail.reactivated", "ms7.mail.reason"];
  const joined = body.map((k) => t(k, vars)).join(t.locale === "zh" ? "" : " ");
  const text = `${t("mail.hi", { name: user.name.split(/\s+/)[0] })}\n\n${joined}\n\n${linkIn(`${baseUrl()}/account`, locale)}\n\n${siteName()}`;
  await enqueue({
    venueId: m.venue_id,
    kind: "account_email",
    channel: "email",
    recipient: user.email,
    locale,
    subject: "msg.programmeSubject",
    body: "msg.programmeBody",
    vars: { subject: t(subject, vars), text },
  });
  return true;
}
