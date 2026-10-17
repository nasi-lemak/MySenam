import { createBackup, hoursSinceLastBackup } from "./backup";
import { copyOffsite } from "./offsite";
import { tickOutbox } from "./notify";
import { issueDueInvoices } from "./billing";
import { applyPaymentHolds } from "./payment-holds";
import { leagueHousekeeping } from "./leagues";

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

/** The hour, Malaysia time, the nightly backup is taken at. */
export function backupHour(): number {
  const hour = Number(process.env.MYSENAM_BACKUP_HOUR ?? 3);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;
}

function malaysiaHour(now: Date): number {
  return (now.getUTCHours() + 8) % 24;
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

  try {
    const drained = await tickOutbox();
    if (drained.transport) result.outbox = { sent: drained.sent, failed: drained.failed };
  } catch (err) {
    console.error("[mysenam] sending messages failed:", err);
  }

  try {
    // A marketplace's monthly invoices, on the first tick of the month.
    const issued = await issueDueInvoices(now);
    if (issued.length > 0) result.invoices = issued.length;
  } catch (err) {
    console.error("[mysenam] issuing invoices failed:", err);
  }

  try {
    // Off the marketplace when long overdue, back once paid.
    await applyPaymentHolds(now);
  } catch (err) {
    console.error("[mysenam] checking for overdue invoices failed:", err);
  }

  try {
    // League results nobody answered, and seasons due to end or start.
    await leagueHousekeeping();
  } catch (err) {
    console.error("[mysenam] league housekeeping failed:", err);
  }

  try {
    if (backupDue(now, hoursSinceLastBackup())) {
      const taken = await createBackup();
      if (!taken.ok) {
        result.backup = { ok: false, error: taken.error };
        console.error(`[mysenam] scheduled backup failed: ${taken.error}`);
      } else {
        const offsite = await copyOffsite(taken.file);
        result.backup = {
          ok: true,
          name: taken.file.name,
          offsite: offsite && (offsite.ok ? { ok: true } : { ok: false, error: offsite.error }),
        };
        if (offsite && !offsite.ok)
          console.error(`[mysenam] off-site copy of ${taken.file.name} failed: ${offsite.error}`);
      }
    }
  } catch (err) {
    console.error("[mysenam] scheduled backup failed:", err);
  }

  return result;
}

export function schedulerEnabled(): boolean {
  const setting = process.env.MYSENAM_SCHEDULER;
  if (setting === "off") return false;
  return setting === "on" || process.env.NODE_ENV === "production";
}

const state = globalThis as { __mysenamScheduler?: ReturnType<typeof setInterval> };

/** Start ticking, once per process. */
export function startScheduler(): void {
  if (state.__mysenamScheduler || !schedulerEnabled()) return;
  let busy = false;
  const tick = async () => {
    // A slow upload must not have the next minute start a second one.
    if (busy) return;
    busy = true;
    try {
      await runScheduledWork();
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
