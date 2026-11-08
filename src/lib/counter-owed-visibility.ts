import { counterOwed } from "./counter-refunds";
import { getDb } from "./db";
import { staffSentences, tellVenueStaffEach } from "./owner-alerts";
import { money, roundMoney } from "./region";
import type { StaffRole } from "./roles";
import { venueHours } from "./store";
import { currentHour, todayISO } from "./time";

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
    await tellVenueStaffEach(
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
    told.push(venueId);
  }
  return told;
}
