import { expireHolds } from "./games";
import { expireMoves } from "./game-moves";
import { extendSeriesIfDue } from "./game-series";
import { sendMatchNotices } from "./matchmaking";
import crypto from "crypto";
import { getDb } from "./db";
import { pruneIfDue } from "./privacy";
import { grantLoyaltyIfDue } from "./loyalty";
import { checkIntegrityIfDue } from "./integrity";
import { createBackup, hoursSinceLastBackup } from "./backup";
import { copyOffsite } from "./offsite";
import { backupHealth } from "./backup-health";
import { tickOutbox } from "./notify";
import { issueDueInvoices } from "./billing";
import { issueDueAccountInvoices, remindOverdueAccountInvoices } from "./accounts";
import { applyPaymentHolds, notifyInvoiceStages } from "./payment-holds";
import { leagueHousekeeping } from "./leagues";
import { runEInvoicing } from "./myinvois";
import { runAccountingPush } from "./accounting-push";
import { askForReviews } from "./reviews";
import { notifyCoaches } from "./coach-schedule";
import { runWebhooks } from "./webhooks";
import { passOnExpiredOffers } from "./store";
import { holdStrandedBookings, releaseExpiredHolds } from "./holds";
import { reconcileRefunds, settlePendingRefunds, settleRefundClaims } from "./payments";
import { closeDueEntries } from "./tournaments";
import { checkMessages, heartbeat, raiseAlert } from "./alerts";
import { region } from "./region";
import { said, type ServerPhrase } from "./staff-text";

/** "Scheduled work failed: …", said in the staff language on the owner's dashboard. */
const failed = (what: ServerPhrase) => said("srv.alert.failed", { what: said(what) });

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
    await raiseAlert("scheduler:sending-messages-failed", failed("srv.work.sendingMessages"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A refund claimed when the app stopped mid-call: asked again under its own key.
    await settleRefundClaims();
    // Accepted and still going through: made, or failed and owed again.
    await settlePendingRefunds();
    // Owed at any venue: reconciled; asked of the gateway where the venue refunds by itself, its staff told where they must act.
    await reconcileRefunds();
  } catch (err) {
    console.error("[mysenam] settling interrupted refunds failed:", err);
    await raiseAlert("scheduler:settling-refunds-failed", failed("srv.work.settlingRefunds"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Tournaments whose last day for entries has gone by: closed, ready for the draw.
    await closeDueEntries();
  } catch (err) {
    console.error("[mysenam] closing tournament entries failed:", err);
    await raiseAlert("scheduler:closing-entries-failed", failed("srv.work.closingEntries"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Bookings whose request died before their hold was applied get it, from when they were made (lib/holds.ts).
    await holdStrandedBookings();
    // Bookings held for payment that never came: free for somebody else.
    await releaseExpiredHolds();
    // Membership purchases whose hold lapsed with no payment: holding nobody (lib/membership-purchases.ts).
    await (await import("./membership-purchases")).releaseLapsedPurchases();
  } catch (err) {
    console.error("[mysenam] letting go of unpaid holds failed:", err);
    await raiseAlert("scheduler:letting-go-of-unpaid-holds-failed", failed("srv.work.unpaidHolds"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Entries without a booking past their longest stay: they had stopped counting; closed as having ended then (lib/entries.ts).
    await (await import("./entries")).closeEndedEntries(now);
  } catch (err) {
    console.error("[mysenam] closing entries failed:", err);
    await raiseAlert("scheduler:closing-entries-without-booking-failed", failed("srv.work.entries"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A marketplace's monthly invoices, on the first tick of the month.
    const issued = await issueDueInvoices(now);
    if (issued.length > 0) result.invoices = issued.length;
  } catch (err) {
    console.error("[mysenam] issuing invoices failed:", err);
    await raiseAlert("scheduler:issuing-invoices-failed", failed("srv.work.issuingInvoices"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // The platform's invoice to each venue, told to its managers when issued and again a few days before it falls due.
    await notifyInvoiceStages(now);
  } catch (err) {
    console.error("[mysenam] telling venues about their invoices failed:", err);
    await raiseAlert("scheduler:invoice-notices-failed", failed("srv.work.invoiceNotices"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Company and school accounts: last month's invoice, early in the month.
    await issueDueAccountInvoices();
  } catch (err) {
    console.error("[mysenam] invoicing accounts failed:", err);
    await raiseAlert("scheduler:invoicing-accounts-failed", failed("srv.work.invoicingAccounts"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Company and school accounts: invoices past their day are reminded to the account, weekly (lib/accounts.ts).
    await remindOverdueAccountInvoices();
  } catch (err) {
    console.error("[mysenam] reminding overdue accounts failed:", err);
    await raiseAlert("scheduler:reminding-overdue-accounts-failed", failed("srv.work.remindingAccounts"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Off the marketplace when long overdue, back once paid.
    await applyPaymentHolds(now);
  } catch (err) {
    console.error("[mysenam] checking for overdue invoices failed:", err);
    await raiseAlert("scheduler:checking-for-overdue-invoices-failed", failed("srv.work.overdueInvoices"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // League results nobody answered, and seasons due to end or start.
    await leagueHousekeeping();
    // Team leagues' unanswered fixture reports stand; teams' left members and old invitations are forgotten (lib/team-leagues.ts, lib/teams.ts).
    await (await import("./team-leagues")).teamLeagueHousekeeping();
    await (await import("./teams")).teamHousekeeping();
    // Ladders: reports nobody answered stand, ignored challenges forfeit, freezes end, idle players drop (lib/ladders.ts).
    await (await import("./ladders")).ladderHousekeeping();
  } catch (err) {
    console.error("[mysenam] league housekeeping failed:", err);
    await raiseAlert("scheduler:league-housekeeping-failed", failed("srv.work.leagueHousekeeping"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Ratings: every rated event whose results differ from when it was last read is read again (lib/ratings.ts); safe to repeat.
    await (await import("./ratings")).ratingsCatchUp();
  } catch (err) {
    console.error("[mysenam] reading results into the ratings failed:", err);
    await raiseAlert("scheduler:ratings-failed", failed("srv.work.ratings"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Tournament day: whose match is next on each court, told once (lib/tournament-day.ts).
    await (await import("./tournament-day")).announceAll();
  } catch (err) {
    console.error("[mysenam] announcing the next tournament matches failed:", err);
    await raiseAlert("scheduler:tournament-day-failed", failed("srv.work.tournamentDay"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Tournament reports nobody answered stand.
    await (await import("./match-reports")).standUnansweredReports();
  } catch (err) {
    console.error("[mysenam] standing unanswered reports failed:", err);
    await raiseAlert("scheduler:unanswered-reports-failed", failed("srv.work.unansweredReports"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Free hours earned by regulars at venues that give them, once a day.
    await grantLoyaltyIfDue();
  } catch (err) {
    console.error("[mysenam] giving loyalty hours failed:", err);
    await raiseAlert("scheduler:loyalty-failed", failed("srv.work.loyalty"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // The retention policy, once a day: not left to whenever staff next open the dashboard.
    await pruneIfDue();
  } catch (err) {
    console.error("[mysenam] applying the retention policy failed:", err);
    await raiseAlert("scheduler:retention-failed", failed("srv.work.retention"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Court time long over moves out of the table bookings are checked against, in bounded batches (lib/claims-archive.ts;
    // off unless CLAIMS_ARCHIVE_AFTER_DAYS is set). The owners hear when it fails, and when it cannot keep up.
    const archived = await (await import("./claims-archive")).archiveClaimsIfDue(now);
    if (archived?.behind) {
      const status = await (await import("./claims-archive")).claimsArchiveStatus(now);
      await raiseAlert("claims-archive-behind", said("srv.alert.claimsBehind"), `${status.days} days; ${status.waiting} due`, [
        said("srv.alert.claimsBehindDetail", { days: status.days, waiting: status.waiting }),
      ]);
    }
  } catch (err) {
    console.error("[mysenam] archiving past court time failed:", err);
    await raiseAlert("scheduler:claims-archive-failed", failed("srv.work.claimsArchive"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Once a day: every live booking still holds its court, and nothing cancelled does.
    const problems = await checkIntegrityIfDue(now);
    if (problems && problems.length > 0)
      await raiseAlert(
        "integrity",
        said(problems.length === 1 ? "srv.alert.integrity_one" : "srv.alert.integrity_other", { n: problems.length }),
        problems.slice(0, 20).map((p) => `${p.kind} (venue ${p.venueId}): ${p.detail}`).join("\n")
      );
  } catch (err) {
    console.error("[mysenam] checking bookings against held time failed:", err);
    await raiseAlert("scheduler:integrity-failed", failed("srv.work.integrity"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Waiting-list offers nobody took pass to the next person in the queue.
    await passOnExpiredOffers();
  } catch (err) {
    console.error("[mysenam] passing on waiting-list offers failed:", err);
    await raiseAlert("scheduler:waitlist-offers-failed", failed("srv.work.waitlistOffers"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Open games: invitations and held places that ran out; each freed place to the next in line.
    await expireHolds();
    // Proposed new times not every player answered: the game stays, the time held is let go.
    await expireMoves();
  } catch (err) {
    console.error("[mysenam] passing on open-game places failed:", err);
    await raiseAlert("scheduler:game-places-failed", failed("srv.work.gamePlaces"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Approval applications: holds whose time is up let go, applications nobody acted on lapsed, renewals asked for.
    await (await import("./approvals")).expireApprovals();
  } catch (err) {
    console.error("[mysenam] approval applications failed:", err);
    await raiseAlert("scheduler:approvals-failed", "Scheduled work failed: approval applications", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Youth messaging's interim safeguards (ADR 0052): protective restrictions past their review date are told to the owners (never lifted), authority reviews open
    // where a guardian link is disputed or unclear, and the owners are asked now and then to decide about what has been kept long (lib/youth-restrictions.ts).
    await (await import("./youth-restrictions")).youthHousekeeping();
  } catch (err) {
    console.error("[mysenam] youth messaging housekeeping failed:", err);
    await raiseAlert("scheduler:youth-housekeeping-failed", "Scheduled work failed: youth messaging safeguards", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Supporting documents waiting in quarantine: scanned when their next try is due (lib/document-scanning.ts).
    const scanning = await import("./document-scanning");
    // Where clamd is started on demand: started when documents wait (scanning them once it answers), stopped when idle.
    const onDemand = await scanning.tickOnDemandScanner();
    // Documents that failed only because no scanner answered go back into quarantine once one does.
    await scanning.requeueWaitingDocuments();
    await scanning.scanDueDocuments(20, { waitingForScanner: onDemand === "running" });
    // Once an hour: is the scanner there, are its signatures fresh, is anything stuck?
    if (now.getUTCMinutes() === 0) await scanning.checkScanner(now.getTime());
  } catch (err) {
    console.error("[mysenam] scanning supporting documents failed:", err);
    await raiseAlert("scheduler:document-scanning-failed", "Scheduled work failed: scanning supporting documents", err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Weekly games: dates added to the host's weekly booking get their games.
    await extendSeriesIfDue(now);
    // Players who asked hear of games suggested for them, each game once.
    await sendMatchNotices();
  } catch (err) {
    console.error("[mysenam] weekly games and suggested-game emails failed:", err);
    await raiseAlert("scheduler:matchmaking-failed", failed("srv.work.matchmaking"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A venue's own systems hear of its bookings changing.
    await runWebhooks(now);
  } catch (err) {
    console.error("[mysenam] webhooks failed:", err);
    await raiseAlert("scheduler:webhooks-failed", failed("srv.work.webhooks"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Coaches hear of lessons booked with them, and of those cancelled.
    await notifyCoaches(now);
  } catch (err) {
    console.error("[mysenam] telling coaches failed:", err);
    await raiseAlert("scheduler:telling-coaches-failed", failed("srv.work.tellingCoaches"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Customers hear, once, that a pass or membership of theirs ends within two weeks (lib/standing-notices.ts).
    await (await import("./standing-notices")).tellExpiring(now);
  } catch (err) {
    console.error("[mysenam] telling customers what ends soon failed:", err);
    await raiseAlert("scheduler:expiry-notices-failed", failed("srv.work.expiryNotices"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // One email, the day after a first visit to a venue, asking how it was.
    await askForReviews(now);
  } catch (err) {
    console.error("[mysenam] asking for reviews failed:", err);
    await raiseAlert("scheduler:asking-for-reviews-failed", failed("srv.work.reviews"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Malaysian e-invoices: last month consolidated early in the month, then sent and checked.
    await runEInvoicing(now);
  } catch (err) {
    console.error("[mysenam] e-invoicing failed:", err);
    await raiseAlert("scheduler:e-invoicing-failed", failed("srv.work.eInvoicing"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // A venue's sales pushed to its accounting package, where a manager connected one (lib/accounting-push.ts); off otherwise.
    await runAccountingPush(now);
  } catch (err) {
    console.error("[mysenam] sending sales to the accounting package failed:", err instanceof Error ? err.name : "unknown");
    await raiseAlert("scheduler:accounting-push-failed", failed("srv.work.accounting"), err instanceof Error ? err.name : "unknown");
  }

  try {
    if (backupDue(now, hoursSinceLastBackup())) {
      const taken = await createBackup();
      if (!taken.ok) {
        result.backup = { ok: false, error: taken.error };
        console.error(`[mysenam] scheduled backup failed: ${taken.error}`);
        await raiseAlert("backup", said("srv.alert.backupFailed"), taken.error);
      } else {
        const offsite = await copyOffsite(taken.file, taken.photos.file, taken.manifest);
        result.backup = {
          ok: true,
          name: taken.file.name,
          offsite: offsite && (offsite.ok ? { ok: true } : { ok: false, error: offsite.error }),
        };
        if (offsite && !offsite.ok) {
          console.error(`[mysenam] off-site copy of ${taken.file.name} failed: ${offsite.error}`);
          await raiseAlert("offsite", said("srv.alert.offsiteFailed"), `${taken.file.name}: ${offsite.error}`);
        }
      }
    }
  } catch (err) {
    console.error("[mysenam] scheduled backup failed:", err);
    await raiseAlert("scheduler:scheduled-backup-failed", failed("srv.work.backup"), err instanceof Error ? err.stack ?? err.message : String(err));
  }

  try {
    // Erasure-ledger entries not yet off-site, copied (tried again each minute until accepted); once an hour,
    // the owners told of one still waiting (lib/erasure-ledger-offsite.ts).
    const ledger = await import("./erasure-ledger-offsite");
    await ledger.shipLedger(now);
    if (now.getUTCMinutes() === 0) await ledger.checkLedgerShipping(now.getTime());
  } catch (err) {
    console.error("[mysenam] copying the erasure ledger off-site failed:", err);
  }

  try {
    // Once an hour, and after each backup: is there a copy recent enough to recover from?
    if (result.backup !== null || now.getUTCMinutes() === 0) await checkBackupHealth(now);
  } catch (err) {
    console.error("[mysenam] checking backups failed:", err);
  }

  return result;
}

/**
 * Tell the owners when the newest copy that would survive losing the server
 * is older than the recovery-point target, or when off-site sets are nearing
 * the largest single upload. A failed or paused copy is told as it happens
 * (the "offsite" alert above); this catches what that cannot, such as copies
 * that stopped because the server's clock or schedule did.
 */
export async function checkBackupHealth(now = new Date()): Promise<void> {
  const health = await backupHealth(now.getTime());
  if (health.recoverableHours !== null && health.recoverableHours > health.rpoHours) {
    const detail = health.problems.join("\n");
    console.error(`[mysenam] backups are behind: ${detail}`);
    await raiseAlert("backup-stale", said("srv.alert.backupStale"), detail, health.problemPhrases);
  } else if (health.recoverableHours === null && health.offsite !== "off" && health.lastLocalAt) {
    const detail = health.problems.join("\n");
    console.error(`[mysenam] nothing copied off-site: ${detail}`);
    await raiseAlert("backup-stale", said("srv.alert.nothingOffsite"), detail, health.problemPhrases);
  }
  if (health.nearSizeLimit) await raiseAlert("offsite-near-limit", said("srv.alert.nearLimit"), health.problems.join("\n"), health.problemPhrases);
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
