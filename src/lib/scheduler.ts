import crypto from "crypto";
import { getDb } from "./db";
import { pruneIfDue } from "./privacy";
import { grantLoyaltyIfDue } from "./loyalty";
import { checkIntegrityIfDue } from "./integrity";
import { createBackup, hoursSinceLastBackup } from "./backup";
import { copyOffsite } from "./offsite";
import { tickOutbox } from "./notify";
import { issueDueInvoices } from "./billing";
import { issueDueAccountInvoices } from "./accounts";
import { applyPaymentHolds } from "./payment-holds";
import { leagueHousekeeping } from "./leagues";
import { runEInvoicing } from "./myinvois";
import { askForReviews } from "./reviews";
import { notifyCoaches } from "./coach-schedule";
import { runWebhooks } from "./webhooks";
import { passOnExpiredOffers } from "./store";
import { releaseExpiredHolds } from "./holds";
import { settleRefundClaims } from "./payments";
import { checkMessages, heartbeat, raiseAlert } from "./alerts";
import { region } from "./region";

/**
 * The few things that have to happen whether or not anybody is using the
 * site: the nightly backup, and the messages that are waiting to go.
 *
 * MySenam was built to need no scheduler, and it still does not — every one
 * of these also happens lazily, or from a button. But a host like Render
 * cannot run a cron job against a web service's disk, and a waitlist offer
 * that waits for the next visitor to be sent has already half expired. So the
 * server ticks once a minute and does what is due. If it is down at 3am, the
 * backup is taken when it comes back.
 *
 * On by default in production, where `next start` runs it. MYSENAM_SCHEDULER=off
 * turns it off — for an install that keeps its own cron, or runs more than one
 * server against the same database.
 */

const MINUTE = 60_000;

/** The hour, local time, the nightly backup is taken at. */
export function backupHour(): number {
  const hour = Number(process.env.MYSENAM_BACKUP_HOUR ?? 3);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;
}

function malaysiaHour(now: Date): number {
  return (now.getUTCHours() + region().utcOffsetHours) % 24;
}

/**
 * Is a backup due? At the backup hour if the last one is most of a day old;
 * straight away if there has never been one, or the last is more than a day
 * old because the server was down when the hour came round.
 */
export function backupDue(now: Date, hoursSinceLast: number | null, hour = backupHour()): boolean {
  if (hoursSinceLast === null) return true;
  if (hoursSinceLast >= 26) return true;
  return hoursSinceLast >= 20 && malaysiaHour(now) === hour;
}

export interface TickResult {
  invoices?: number;
  backup: { ok: boolean; name?: string; error?: string; offsite?: { ok: boolean; error?: string } | null } | null;
  outbox: { sent: number; failed: number } | null;
}

/** Do whatever is due now. Never throws: one failure must not stop the next tick. */
export async function runScheduledWork(now = new Date()): Promise<TickResult> {
  const result: TickResult = { backup: null, outbox: null };
  // Stamped first, so a scheduler that has stopped shows on /api/health.
  await heartbeat().catch(() => undefined);

  try {
    const drained = await tickOutbox();
    if (drained.transport) result.outbox = { sent: drained.sent, failed: drained.failed };
    // Several failing and none getting through: the account, not one address.
    if (drained.failed > 0) await checkMessages();
  } catch (err) {
    console.error("[mysenam] sending messages failed:", err);
    await raiseAlert("scheduler:sending-messages-failed", "Scheduled work failed: sending messages", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A refund claimed when the app stopped mid-call: asked again under its own key.
    await settleRefundClaims();
  } catch (err) {
    console.error("[mysenam] settling interrupted refunds failed:", err);
    await raiseAlert("scheduler:settling-refunds-failed", "Scheduled work failed: settling interrupted refunds", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Bookings held for payment that never came: free for somebody else.
    await releaseExpiredHolds();
  } catch (err) {
    console.error("[mysenam] letting go of unpaid holds failed:", err);
    await raiseAlert("scheduler:letting-go-of-unpaid-holds-failed", "Scheduled work failed: letting go of unpaid holds", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A marketplace's monthly invoices, on the first tick of the month.
    const issued = await issueDueInvoices(now);
    if (issued.length > 0) result.invoices = issued.length;
  } catch (err) {
    console.error("[mysenam] issuing invoices failed:", err);
    await raiseAlert("scheduler:issuing-invoices-failed", "Scheduled work failed: issuing invoices", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Company and school accounts: last month's invoice, early in the month.
    await issueDueAccountInvoices();
  } catch (err) {
    console.error("[mysenam] invoicing accounts failed:", err);
    await raiseAlert("scheduler:invoicing-accounts-failed", "Scheduled work failed: invoicing company and school accounts", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Off the marketplace when long overdue, back once paid.
    await applyPaymentHolds(now);
  } catch (err) {
    console.error("[mysenam] checking for overdue invoices failed:", err);
    await raiseAlert("scheduler:checking-for-overdue-invoices-failed", "Scheduled work failed: checking for overdue invoices", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // League results nobody answered, and seasons due to end or start.
    await leagueHousekeeping();
  } catch (err) {
    console.error("[mysenam] league housekeeping failed:", err);
    await raiseAlert("scheduler:league-housekeeping-failed", "Scheduled work failed: league housekeeping", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Free hours earned by regulars at venues that give them, once a day.
    await grantLoyaltyIfDue();
  } catch (err) {
    console.error("[mysenam] giving loyalty hours failed:", err);
    await raiseAlert("scheduler:loyalty-failed", "Scheduled work failed: loyalty hours", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // The retention policy, once a day: not left to whenever staff next open the dashboard.
    await pruneIfDue();
  } catch (err) {
    console.error("[mysenam] applying the retention policy failed:", err);
    await raiseAlert("scheduler:retention-failed", "Scheduled work failed: applying the retention policy", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Once a day: every live booking still holds its court, and nothing cancelled does.
    const problems = await checkIntegrityIfDue(now);
    if (problems && problems.length > 0)
      await raiseAlert(
        "integrity",
        `${problems.length} booking${problems.length === 1 ? "" : "s"} and the court time held disagree`,
        problems.slice(0, 20).map((p) => `${p.kind} (venue ${p.venueId}): ${p.detail}`).join("\n")
      );
  } catch (err) {
    console.error("[mysenam] checking bookings against held time failed:", err);
    await raiseAlert("scheduler:integrity-failed", "Scheduled work failed: checking bookings against held time", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Waiting-list offers nobody took pass to the next person in the queue.
    await passOnExpiredOffers();
  } catch (err) {
    console.error("[mysenam] passing on waiting-list offers failed:", err);
    await raiseAlert("scheduler:waitlist-offers-failed", "Scheduled work failed: waiting-list offers", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A venue's own systems hear of its bookings changing.
    await runWebhooks(now);
  } catch (err) {
    console.error("[mysenam] webhooks failed:", err);
    await raiseAlert("scheduler:webhooks-failed", "Scheduled work failed: webhooks", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Coaches hear of lessons booked with them, and of those cancelled.
    await notifyCoaches(now);
  } catch (err) {
    console.error("[mysenam] telling coaches failed:", err);
    await raiseAlert("scheduler:telling-coaches-failed", "Scheduled work failed: telling coaches", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // One email, the day after a first visit to a venue, asking how it was.
    await askForReviews(now);
  } catch (err) {
    console.error("[mysenam] asking for reviews failed:", err);
    await raiseAlert("scheduler:asking-for-reviews-failed", "Scheduled work failed: asking for reviews", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Malaysian e-invoices: last month consolidated early in the month, then sent and checked.
    await runEInvoicing(now);
  } catch (err) {
    console.error("[mysenam] e-invoicing failed:", err);
    await raiseAlert("scheduler:e-invoicing-failed", "Scheduled work failed: e-invoicing", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    if (backupDue(now, hoursSinceLastBackup())) {
      const taken = await createBackup();
      if (!taken.ok) {
        result.backup = { ok: false, error: taken.error };
        console.error(`[mysenam] scheduled backup failed: ${taken.error}`);
        await raiseAlert("backup", "The nightly backup failed", taken.error);
      } else {
        const offsite = await copyOffsite(taken.file, taken.photos.file);
        result.backup = {
          ok: true,
          name: taken.file.name,
          offsite: offsite && (offsite.ok ? { ok: true } : { ok: false, error: offsite.error }),
        };
        if (offsite && !offsite.ok) {
          console.error(`[mysenam] off-site copy of ${taken.file.name} failed: ${offsite.error}`);
          await raiseAlert("offsite", "The off-site copy of the backup failed", `${taken.file.name}: ${offsite.error}`);
        }
      }
    }
  } catch (err) {
    console.error("[mysenam] scheduled backup failed:", err);
    await raiseAlert("scheduler:scheduled-backup-failed", "Scheduled work failed: scheduled backup", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  return result;
}

export function schedulerEnabled(): boolean {
  const setting = process.env.MYSENAM_SCHEDULER;
  if (setting === "off") return false;
  return setting === "on" || process.env.NODE_ENV === "production";
}

const state = globalThis as { __mysenamScheduler?: ReturnType<typeof setInterval> };

/** This process, among the app's instances: who holds the scheduler's lease. */
const INSTANCE = `${process.env.HOSTNAME ?? "app"}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
/** Held this long past each renewal: an instance that stops is taken over within three minutes. */
export const LEASE_MS = 3 * MINUTE;

/**
 * The scheduled work runs on one instance at a time, however many there are:
 * backups, reminders, invoices and released holds must not happen twice. The
 * lease is a row in `settings` naming the instance and when it runs out; an
 * instance takes it when it is free or has run out, and renews it each tick
 * and every minute while one runs (`withSchedulerLease`).
 * Works with any connection pooling, and on PGlite.
 */
export async function holdSchedulerLease(instance = INSTANCE, now = Date.now()): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('scheduler_lease', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
        WHERE split_part(settings.value, '|', 1) = ? OR split_part(settings.value, '|', 2)::bigint < ?
       RETURNING value`
    )
    .get(`${instance}|${now + LEASE_MS}`, instance, now);
  return row !== undefined;
}

/**
 * Run work holding the lease, renewed every minute while it runs: a tick that
 * outlasts the lease (a large backup and its upload) does not let another
 * instance decide this one has stopped and start the same work. False, and
 * nothing run, when another instance has it.
 */
export async function withSchedulerLease(work: () => Promise<void>, instance = INSTANCE): Promise<boolean> {
  if (!(await holdSchedulerLease(instance).catch(() => false))) return false;
  const renew = setInterval(() => void holdSchedulerLease(instance).catch(() => false), MINUTE);
  renew.unref?.();
  try {
    await work();
  } finally {
    clearInterval(renew);
  }
  return true;
}

/** Start ticking, once per process. */
export function startScheduler(): void {
  if (state.__mysenamScheduler || !schedulerEnabled()) return;
  let busy = false;
  const tick = async () => {
    // A slow upload must not have the next minute start a second one.
    if (busy) return;
    busy = true;
    try {
      // Another instance has it: this one serves pages and leaves the rest.
      await withSchedulerLease(async () => {
        await runScheduledWork();
      });
    } finally {
      busy = false;
    }
  };
  state.__mysenamScheduler = setInterval(tick, MINUTE);
  state.__mysenamScheduler.unref?.();
  // Soon after starting, rather than a minute in: a server that was down at
  // the backup hour catches up straight away.
  setTimeout(tick, 15_000).unref?.();
}
