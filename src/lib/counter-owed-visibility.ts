import { isOwner, listAdmins } from "./admin-auth";
import { counterOwed } from "./counter-refunds";
import { getDb } from "./db";
import { staffSentences, tellOwnersEach, tellVenueStaffEach } from "./owner-alerts";
import { clockTime, money, roundMoney } from "./region";
import type { StaffRole } from "./roles";
import type { StaffT } from "./staff-i18n";
import { venueHours } from "./store";
import { currentHour, installZone, localDateOf, todayISO } from "./time";

/**
 * Counter payments owed back to customers, made visible to the people who must hand them back (ADR 0076;
 * docs/operations/pilot-daily-operations.md, docs/features/payments-and-credit.md#owed-back-after-the-venue-cancels).
 *
 * The list *Owed back at the counter* (`counterOwed`, lib/counter-refunds.ts) is the source of truth. It was seen only by opening it. Two
 * readings of the same rows make it seen:
 *
 * - a line in *Needs attention* (`counterOwedSummary`): per venue how many wait, what in all, how long the oldest has, and how many have
 *   waited `REFUND_OVERDUE_DAYS` or more. Every cause is counted (the customer cancelled, a place was withdrawn, the venue closed, a
 *   court went out of service, a rain-out, a class called off, a booking moved to a cheaper time);
 * - one message per venue per day to its managers (`sendCounterOwedDigests`), run by the scheduler's short unit.
 *
 * Neither changes a row. A message delivered, opened or ignored settles nothing: a row leaves the list only when a named member of staff
 * presses *Handed back* or *Give as credit* (`settleOwed`), and the digest stops by itself because the rows are gone.
 */

/** Owed this many whole days or more: counted as overdue, in the line and in the message. A constant; not a setting. */
export const REFUND_OVERDUE_DAYS = 2;
/** The venue's own hour (its time zone) from which the day's message may go. */
export const COUNTER_OWED_DIGEST_HOUR = 9;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CounterOwedSummary {
  venueId: number;
  venueName: string;
  count: number;
  /** In all, in the install's currency. */
  amount: number;
  /** Whole days the oldest has waited. */
  oldestDays: number;
  /** How many have waited `REFUND_OVERDUE_DAYS` or more. */
  overdue: number;
  overdueAfterDays: number;
}

/**
 * What is still owed back at the counter at these venues (every venue where null), one entry per venue that has any, oldest-waiting first.
 * Computed from `counterOwed`, so it is exactly the list staff are shown, and holds no customer's name.
 */
export async function counterOwedSummary(venueIds: number[] | null, role: StaffRole = "manager", now: number = Date.now()): Promise<CounterOwedSummary[]> {
  const rows = await counterOwed(venueIds, role);
  if (rows.length === 0) return [];
  const names = new Map(
    ((await getDb().prepare(`SELECT id, name FROM venues WHERE id IN (${[...new Set(rows.map((r) => r.venueId))].map(() => "?").join(",")})`).all(...new Set(rows.map((r) => r.venueId)))) as {
      id: number;
      name: string;
    }[]).map((v) => [v.id, v.name])
  );
  const byVenue = new Map<number, CounterOwedSummary>();
  for (const r of rows) {
    const days = Math.max(0, Math.floor((now - new Date(r.owedSince).getTime()) / DAY_MS));
    const v = byVenue.get(r.venueId) ?? { venueId: r.venueId, venueName: names.get(r.venueId) ?? "", count: 0, amount: 0, oldestDays: 0, overdue: 0, overdueAfterDays: REFUND_OVERDUE_DAYS };
    v.count++;
    v.amount = roundMoney(v.amount + r.amount);
    v.oldestDays = Math.max(v.oldestDays, days);
    if (days >= REFUND_OVERDUE_DAYS) v.overdue++;
    byVenue.set(r.venueId, v);
  }
  return [...byVenue.values()].sort((a, b) => b.oldestDays - a.oldestDays || a.venueId - b.venueId);
}

/**
 * Once per venue per venue-local day, from `COUNTER_OWED_DIGEST_HOUR`: one message to the venue's managers (and the managers of its business;
 * the front desk is not written to) saying how many counter refunds wait, the sum, the oldest age and how many are overdue. No customer, no
 * booking, no item: the list is where those are. The same rule runs on every tick and on every instance, and sends once, because each
 * person's message is queued under the key `counter-owed:<venue>:<local day>:<email>` (the outbox writes a key once), so a restart, a repeated
 * tick or two servers at once write nothing more that day. A venue with nothing owed is not written to; the next day with something owed, it is.
 * Returns the venues written to. Never settles, marks or edits a refund.
 */
export async function sendCounterOwedDigests(): Promise<number[]> {
  const venues = (await getDb().prepare("SELECT DISTINCT venue_id FROM counter_refunds_owed WHERE settled_at IS NULL ORDER BY venue_id").all()) as { venue_id: number }[];
  const told: number[] = [];
  for (const { venue_id: venueId } of venues) {
    const { zone } = await venueHours(venueId);
    if (currentHour(zone) < COUNTER_OWED_DIGEST_HOUR) continue;
    const day = todayISO(zone);
    const key = `counter-owed:${venueId}:${day}`;
    const sent = (await getDb().prepare("SELECT 1 AS yes FROM messages WHERE dedupe_key LIKE ? LIMIT 1").get(`${key}:%`)) as { yes: number } | undefined;
    if (sent) continue;
    const [summary] = await counterOwedSummary([venueId], "manager");
    if (!summary) continue;
    const queued = await tellVenueStaffEach(
      venueId,
      (t) => ({
        subject: t.plural("vis.mail.owed.s", summary.count, { venue: summary.venueName }),
        body: staffSentences(
          t,
          t.plural("vis.mail.owed.b", summary.count, { venue: summary.venueName, amount: money(summary.amount), days: summary.oldestDays }),
          summary.overdue > 0 && t.plural("vis.mail.owed.overdue", summary.overdue, { limit: summary.overdueAfterDays }),
          t("vis.mail.owed.how"),
          t("vis.mail.owed.once")
        ),
      }),
      { managersOnly: true, dedupeKey: key }
    );
    // A venue with no manager who has an address was told nothing: it is not counted as told, and the platform owners' summary names it.
    if (queued > 0) told.push(venueId);
  }
  return told;
}

// ------------------------------------------------------------ the platform owners' daily summary (ADR 0079)

/** The window the owners' summary covers: the 24 hours ending at the moment it is prepared. */
export const OWNER_DIGEST_WINDOW_HOURS = 24;
/** The outbox key of an owner's summary for a platform day: `owner-refunds:<day>:<email>`. Not `counter-owed:`, which is the venues' own. */
export const OWNER_DIGEST_KEY = "owner-refunds";

export interface OwnerDigestVenue {
  venueId: number;
  venueName: string;
  /** Still owed back now: how many, in all, the whole days the oldest has waited, and how many have waited `REFUND_OVERDUE_DAYS` or more. */
  open: number;
  openAmount: number;
  oldestDays: number;
  overdue: number;
  /** Written down as owed within the window (settled since or not). */
  newlyOwed: number;
  newlyOwedAmount: number;
  /** Settled (handed back, or given as credit) within the window. */
  settled: number;
  settledAmount: number;
  /** Online payments on the venue's list *Payments to check*, not yet marked checked. */
  paymentsToCheck: number;
  /** Managers of the venue (or its business) with an address: none means the venue's own daily message reaches nobody. */
  managers: number;
}

export interface OwnerRefundDigest {
  /** The platform day (YYYY-MM-DD) in the install's zone, and the zone. */
  day: string;
  zone: string;
  /** The window, ISO UTC: the 24 hours ending at the moment the numbers were read. */
  from: string;
  to: string;
  overdueAfterDays: number;
  /** Each venue with anything owed, settled or newly owed in the window, or a payment to check, by name. */
  venues: OwnerDigestVenue[];
}

interface DigestRow {
  venue_id: number;
  venue_name: string;
  open_n: number;
  open_sum: number;
  oldest: string | Date | null;
  overdue_n: number;
  new_n: number;
  new_sum: number;
  settled_n: number;
  settled_sum: number;
  checks: number;
  managers: number;
}

/**
 * Every venue's counter refunds and payments to check, as they stand at `now`, for the platform owners: counts, sums, ages and venue names, never a
 * customer, booking or item. One statement, so every number in a summary is from the same moment: a refund settled while it is being prepared is in it
 * as still owed (it was, when read), and is gone from the next day's. Reads the same rows as `counterOwed` (`counter_refunds_owed` with its booking,
 * `settled_at` null: owed) and the same list as *Payments to check* (`settlement_issue` set, not yet `settlement_reviewed_at`); changes nothing.
 */
export async function ownerRefundSummary(now: number = Date.now()): Promise<OwnerRefundDigest> {
  const zone = installZone();
  const to = new Date(now).toISOString();
  const from = new Date(now - OWNER_DIGEST_WINDOW_HOURS * 3_600_000).toISOString();
  const overdueBy = new Date(now - REFUND_OVERDUE_DAYS * DAY_MS).toISOString();
  const rows = (await getDb()
    .prepare(
      `WITH owed AS (
         SELECT o.venue_id,
                (COUNT(*) FILTER (WHERE o.settled_at IS NULL))::int AS open_n,
                COALESCE(SUM(o.amount) FILTER (WHERE o.settled_at IS NULL), 0)::float AS open_sum,
                MIN(o.owed_since) FILTER (WHERE o.settled_at IS NULL) AS oldest,
                (COUNT(*) FILTER (WHERE o.settled_at IS NULL AND o.owed_since <= ?::timestamptz))::int AS overdue_n,
                (COUNT(*) FILTER (WHERE o.owed_since > ?::timestamptz AND o.owed_since <= ?::timestamptz))::int AS new_n,
                COALESCE(SUM(o.amount) FILTER (WHERE o.owed_since > ?::timestamptz AND o.owed_since <= ?::timestamptz), 0)::float AS new_sum,
                (COUNT(*) FILTER (WHERE o.settled_at > ?::timestamptz AND o.settled_at <= ?::timestamptz))::int AS settled_n,
                COALESCE(SUM(o.amount) FILTER (WHERE o.settled_at > ?::timestamptz AND o.settled_at <= ?::timestamptz), 0)::float AS settled_sum
           FROM counter_refunds_owed o JOIN bookings b ON b.id = o.booking_id
          WHERE o.settled_at IS NULL OR o.settled_at > ?::timestamptz OR o.owed_since > ?::timestamptz
          GROUP BY o.venue_id
       ), checks AS (
         SELECT venue_id, COUNT(*)::int AS n FROM online_payments
          WHERE purpose NOT IN ('invoice', 'pack') AND settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL
          GROUP BY venue_id
       )
       SELECT v.id AS venue_id, v.name AS venue_name,
              COALESCE(owed.open_n, 0) AS open_n, COALESCE(owed.open_sum, 0) AS open_sum, owed.oldest, COALESCE(owed.overdue_n, 0) AS overdue_n,
              COALESCE(owed.new_n, 0) AS new_n, COALESCE(owed.new_sum, 0) AS new_sum,
              COALESCE(owed.settled_n, 0) AS settled_n, COALESCE(owed.settled_sum, 0) AS settled_sum,
              COALESCE(checks.n, 0) AS checks,
              (SELECT COUNT(*)::int FROM admins a
                WHERE (a.venue_id = v.id OR a.business_id = v.business_id) AND NOT (a.venue_id IS NOT NULL AND a.role = 'desk') AND btrim(a.email) <> '') AS managers
         FROM venues v LEFT JOIN owed ON owed.venue_id = v.id LEFT JOIN checks ON checks.venue_id = v.id
        WHERE owed.venue_id IS NOT NULL OR checks.venue_id IS NOT NULL
        ORDER BY v.name, v.id`
    )
    .all(overdueBy, from, to, from, to, from, to, from, to, from, from)) as DigestRow[];
  return {
    day: todayISO(zone),
    zone,
    from,
    to,
    overdueAfterDays: REFUND_OVERDUE_DAYS,
    venues: rows.map((r) => ({
      venueId: Number(r.venue_id),
      venueName: r.venue_name,
      open: Number(r.open_n),
      openAmount: roundMoney(Number(r.open_sum)),
      oldestDays: r.oldest ? Math.max(0, Math.floor((now - new Date(r.oldest).getTime()) / DAY_MS)) : 0,
      overdue: Number(r.overdue_n),
      newlyOwed: Number(r.new_n),
      newlyOwedAmount: roundMoney(Number(r.new_sum)),
      settled: Number(r.settled_n),
      settledAmount: roundMoney(Number(r.settled_sum)),
      paymentsToCheck: Number(r.checks),
      managers: Number(r.managers),
    })),
  };
}

/** Something for the platform to follow up at this venue: overdue refunds, payments to check, or a venue whose own message reached nobody. */
const needsPlatform = (v: OwnerDigestVenue) => v.overdue > 0 || v.paymentsToCheck > 0 || (v.open > 0 && v.managers === 0);

/** The summary as one owner reads it, in their staff language. Counts, sums, ages and venue names only. */
export function ownerDigestMail(t: StaffT, d: OwnerRefundDigest): { subject: string; body: string } {
  const when = (iso: string) => `${localDateOf(iso, d.zone)} ${clockTime(new Date(iso), d.zone, t.locale)}`;
  const open = d.venues.reduce((n, v) => n + v.open, 0);
  const checks = d.venues.reduce((n, v) => n + v.paymentsToCheck, 0);
  const venueLines = d.venues
    .filter((v) => v.open > 0 || v.newlyOwed > 0 || v.settled > 0)
    .map(
      (v) =>
        `- ${staffSentences(
          t,
          v.open > 0
            ? t("dig.venue.open", { venue: v.venueName, n: v.open, amount: money(v.openAmount), days: v.oldestDays, overdue: v.overdue, limit: d.overdueAfterDays })
            : t("dig.venue.none", { venue: v.venueName }),
          t("dig.venue.window", { owed: v.newlyOwed, owedAmount: money(v.newlyOwedAmount), settled: v.settled, settledAmount: money(v.settledAmount) })
        )}`
    );
  const platformLines = d.venues.filter(needsPlatform).flatMap((v) => [
    ...(v.overdue > 0 ? [`- ${t("dig.platform.overdue", { venue: v.venueName, n: v.overdue, limit: d.overdueAfterDays })}`] : []),
    ...(v.paymentsToCheck > 0 ? [`- ${t("dig.platform.checks", { venue: v.venueName, n: v.paymentsToCheck })}`] : []),
    ...(v.open > 0 && v.managers === 0 ? [`- ${t("dig.platform.nobody", { venue: v.venueName })}`] : []),
  ]);
  return {
    subject: t("dig.s", { day: d.day, n: open, checks }),
    body: [
      t("dig.intro", { day: d.day, zone: d.zone, from: when(d.from), to: when(d.to) }),
      `${t("dig.venueHead")}\n${venueLines.length > 0 ? venueLines.join("\n") : `- ${t("dig.venueNothing")}`}`,
      `${t("dig.platformHead")}\n${platformLines.length > 0 ? platformLines.join("\n") : `- ${t("dig.platformNothing")}`}`,
      staffSentences(t, t("dig.how"), t("dig.once", { hour: `${String(COUNTER_OWED_DIGEST_HOUR).padStart(2, "0")}:00` })),
    ].join("\n\n"),
  };
}

export interface OwnerDigestResult {
  /**
   * `queued`: written to the outbox for at least one owner (queued is not sent: the outbox tries, retries and gives up as it does for every message, and
   * Messages and the *Email* section of System health show how it went); `before_hour`: the platform day's hour has not come; `already_queued`: every owner
   * with an address has the day's summary already; `nothing_to_tell`: nothing is owed back anywhere and no payment waits to be checked; `no_recipient`:
   * there was something to tell and no platform owner with an address (an alert in System health says so).
   */
  status: "queued" | "before_hour" | "already_queued" | "nothing_to_tell" | "no_recipient";
  day: string;
  /** Messages written to the outbox by this call. */
  queued: number;
  /** Platform owners skipped for having no address. */
  noAddress: number;
  digest: OwnerRefundDigest | null;
}

/**
 * Once per platform day (the install's zone: Asia/Kuala_Lumpur for Malaysia), from `COUNTER_OWED_DIGEST_HOUR`: one message to each platform owner with every
 * venue's counter refunds and payments to check (`ownerRefundSummary`), split into what is the venue's to hand back and what needs the platform to follow up.
 * Run by the scheduler's short unit after the venues' own messages (`sendCounterOwedDigests`), through the same outbox: each owner's message is queued under
 * `owner-refunds:<day>:<email>`, which the outbox writes once, so repeated ticks, a restart or two servers at once write nothing more that day.
 * Nothing is sent when nothing is owed back anywhere and no payment waits to be checked: a day with no message is a day with nothing waiting (settled refunds
 * stay on the venues' lists). An owner is never a venue's manager (one account per address, and an owner's account has no venue or business), so no address
 * receives both this and a venue's message. Never settles, marks or edits anything (ADR 0079).
 */
export async function sendOwnerRefundDigest(): Promise<OwnerDigestResult> {
  const zone = installZone();
  const day = todayISO(zone);
  if (currentHour(zone) < COUNTER_OWED_DIGEST_HOUR) return { status: "before_hour", day, queued: 0, noAddress: 0, digest: null };
  const key = `${OWNER_DIGEST_KEY}:${day}`;
  const owners = (await listAdmins()).filter(isOwner);
  const noAddress = owners.filter((o) => o.email.trim() === "").length;
  const done = new Set(
    ((await getDb().prepare("SELECT dedupe_key FROM messages WHERE dedupe_key LIKE ?").all(`${key}:%`)) as { dedupe_key: string }[]).map((r) => r.dedupe_key)
  );
  const waiting = owners.filter((o) => o.email.trim() !== "" && !done.has(`${key}:${o.email.toLowerCase()}`));
  if (owners.length > noAddress && waiting.length === 0) return { status: "already_queued", day, queued: 0, noAddress, digest: null };
  const digest = await ownerRefundSummary();
  if (!digest.venues.some((v) => v.open > 0 || v.paymentsToCheck > 0)) return { status: "nothing_to_tell", day, queued: 0, noAddress, digest };
  if (waiting.length === 0) {
    // Something to tell and nobody to tell it to: the owners' System health panel shows it (an alert's own email would reach nobody either).
    const { raiseAlert } = await import("./alerts");
    const { englishOf, said } = await import("./staff-text");
    const detail = said("srv.dig.noRecipient.detail", { day });
    await raiseAlert("owner-refunds:no-recipient", said("srv.dig.noRecipient.alert"), englishOf(detail), [detail]);
    return { status: "no_recipient", day, queued: 0, noAddress, digest };
  }
  const queued = await tellOwnersEach((t) => ownerDigestMail(t, digest), {
    dedupeKey: key,
    exceptEmails: owners.filter((o) => !waiting.includes(o)).map((o) => o.email),
    noUndoFooter: true,
  });
  return { status: "queued", day, queued, noAddress, digest };
}
