import { getDb } from "./db";
import { emailConfigState, scrubbed, type EmailConfigState, type Env } from "./email-config";
import { englishOf, isStaffText, said, type StaffText } from "./staff-text";

/**
 * What the owner can see of email, and what tells them (ADR 0073): whether it is configured and verified, whether the provider is
 * failing, whether mail is piling up, and how much has been given up, security mail apart. Read from the outbox; nothing here sends
 * or asks a provider. The numbers are in `GET /api/admin/system` (`email`), and a problem is an alert in the owner's *System health*
 * panel, by email and on the alert webhook (lib/alerts.ts), cleared when it is gone.
 */

/** A failure rate worth telling about: at least this many tries in the last hour, and at least this share of them failed. */
const FAILING_MIN_TRIES = 5;
const FAILING_SHARE = 0.5;
/** Mail that has waited this long and is still not out is "piling up", whatever the provider says. */
const BACKLOG_MINUTES = 30;

/** What the owner's *Email* section warns about: production email that cannot go out, delivery not verified, the provider failing, mail piling up, security mail lost. */
export type EmailWarning = "cannot_deliver" | "unverified" | "failing" | "backlog" | "security_mail";

/** One recent reason email did not go, with nothing of the message in it: its kind, whether it will be tried again, and the provider's words sanitized. */
export interface EmailFailure {
  kind: string;
  status: "failed" | "abandoned";
  /** The error as the provider or the outbox gave it, with addresses, links, long tokens and secrets taken out, and cut short. */
  reason: string;
  count: number;
  /** The newest of them, UTC "YYYY-MM-DD HH:MM:SS". */
  lastAt: string;
}

export interface EmailHealth {
  config: Pick<EmailConfigState, "state" | "provider" | "problems" | "productionMarketplace" | "blocksAccountEmail" | "syntheticLog"> & {
    /**
     * `MAIL_DELIVERY_VERIFIED` as the validator reads it (never its value): `verified` matches this provider and sender; `other` is set and does not (a check
     * recorded for another provider or sender); `none` is not set.
     */
    deliveryCheck: "verified" | "other" | "none";
  };
  /** Email messages tried in the last hour: those the provider accepted, those it refused or did not answer, and the share refused. */
  lastHour: { sent: number; failed: number; failureRate: number | null };
  /** The same for the last 24 hours, and the newest acceptance by the provider in them (UTC "YYYY-MM-DD HH:MM:SS"; null: none in the 24 hours). */
  lastDay: { sent: number; failed: number; lastSentAt: string | null };
  /** Email waiting to go (queued, or failed and to be tried again; not a venue's bulk news, which waits its turn by design), and the age of the oldest in minutes. */
  queued: { count: number; oldestMinutes: number | null };
  /**
   * Email given up (not sent) in the last day, with security mail (`auth_email`) counted apart: the part held by the allowance, and the part whose link ran
   * out before it could go.
   */
  givenUp24h: { total: number; security: number; securityAllowance: number; securityExpired: number };
  /** Security mail that failed and is waiting to be tried again (its link may run out first). */
  securityRetrying: number;
  /** The last few reasons email failed or was given up (failed ones still waiting, given-up ones of the last day), grouped by kind and reason. */
  recentFailures: EmailFailure[];
  /** Owner alerts standing now that concern email (lib/alerts.ts keys), newest first. */
  openAlerts: { key: string; subject: string; subjectPhrase: StaffText | null; count: number; lastAt: string }[];
  warnings: EmailWarning[];
  /** The thresholds the warnings use: the same as the owner alerts'. */
  thresholds: { failingMinTries: number; failingShare: number; backlogMinutes: number };
  /** No email message has ever been written on this install. */
  noData: boolean;
}

/** The owner alerts that are about email: its configuration, the provider failing, a backlog, messages not going, messages given up for age, security mail held or run out. */
const EMAIL_ALERT_KEYS = ["config:email", "email:failing", "email:backlog", "messages", "messages-aged-out", "auth-mail-ceiling", "auth-mail-expired", "scheduler:sending-messages-failed"];

/**
 * A provider's or the outbox's error as the owner may read it: no recipient address, no link (a sign-in link is a key to an account), no long token, no
 * configured secret (`scrubbed`), on one line and short. What is left is the kind of failure ("Message rejected: Email address is not verified", "connect
 * ETIMEDOUT"), which is what the owner needs to act.
 */
export function sanitizedReason(text: string, env: Env = process.env): string {
  const clean = scrubbed(env, text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
    .replace(/[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/g, "[address]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[…]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/**
 * Read from the outbox and the owner alerts, in bounded windows (what each query scans is in docs/operations/monitoring.md#email):
 * - tries in the last day: `messages` by `last_attempt_at`, which has no index: one pass over the email rows (one query for the hour and the day);
 * - waiting: by `status` in ('queued', 'failed'), on the `(status, next_attempt_at)` index;
 * - given up in the last day: `status = 'abandoned'` and `created_at` within the day, on the `created_at` index;
 * - recent reasons: failed ones (the status index) and the day's given-up ones (the `created_at` index), the newest 30;
 * - the alerts: `system_alerts`, a handful of rows; whether any email exists: the first email row found.
 */
export async function emailHealth(env: Env = process.env): Promise<EmailHealth> {
  const db = getDb();
  const tried = (await db
    .prepare(
      `SELECT (COUNT(*) FILTER (WHERE status = 'sent' AND last_attempt_at >= datetime('now', '-1 hour')))::int AS sent,
              (COUNT(*) FILTER (WHERE status = 'failed' AND last_attempt_at >= datetime('now', '-1 hour')))::int AS failed,
              (COUNT(*) FILTER (WHERE status = 'sent'))::int AS sent_day,
              (COUNT(*) FILTER (WHERE status = 'failed'))::int AS failed_day,
              MAX(sent_at) FILTER (WHERE status = 'sent') AS last_sent
         FROM messages WHERE channel = 'email' AND last_attempt_at >= datetime('now', '-1 day')`
    )
    .get()) as { sent: number; failed: number; sent_day: number; failed_day: number; last_sent: string | null };
  const waiting = (await db
    .prepare(
      `SELECT COUNT(*)::int AS n,
              MAX(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'utc') - created_at::timestamp)) / 60)::int AS oldest,
              (COUNT(*) FILTER (WHERE status = 'failed' AND kind = 'auth_email'))::int AS security_failed
         FROM messages
        WHERE channel = 'email' AND status IN ('queued', 'failed') AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND kind NOT IN ('campaign', 'review_request')`
    )
    .get()) as { n: number; oldest: number | null; security_failed: number };
  const given = (await db
    .prepare(
      `SELECT COUNT(*)::int AS total,
              (COUNT(*) FILTER (WHERE kind = 'auth_email'))::int AS security,
              (COUNT(*) FILTER (WHERE kind = 'auth_email' AND COALESCE(last_error, '') LIKE 'Not sent: already %'))::int AS allowance,
              (COUNT(*) FILTER (WHERE kind = 'auth_email' AND COALESCE(last_error, '') LIKE 'Not sent: it ran out %'))::int AS expired
         FROM messages WHERE channel = 'email' AND status = 'abandoned' AND created_at >= datetime('now', '-1 day')`
    )
    .get()) as { total: number; security: number; allowance: number; expired: number };
  const failures = (await db
    .prepare(
      `SELECT kind, status, last_error, COALESCE(last_attempt_at, created_at) AS at
         FROM messages
        WHERE channel = 'email' AND last_error IS NOT NULL AND (status = 'failed' OR (status = 'abandoned' AND created_at >= datetime('now', '-1 day')))
        ORDER BY COALESCE(last_attempt_at, created_at) DESC, id DESC LIMIT 30`
    )
    .all()) as { kind: string; status: "failed" | "abandoned"; last_error: string; at: string }[];
  const grouped = new Map<string, EmailFailure>();
  for (const f of failures) {
    const reason = sanitizedReason(f.last_error, env);
    const key = `${f.kind}|${f.status}|${reason}`;
    const seen = grouped.get(key);
    if (seen) seen.count++;
    else grouped.set(key, { kind: f.kind, status: f.status, reason, count: 1, lastAt: String(f.at) });
  }
  const alerts = (await db
    .prepare(`SELECT key, subject, said, count, last_at FROM system_alerts WHERE key IN (${EMAIL_ALERT_KEYS.map(() => "?").join(",")}) ORDER BY last_at DESC`)
    .all(...EMAIL_ALERT_KEYS)) as { key: string; subject: string; said: string | null; count: number; last_at: string }[];
  const any = await db.prepare("SELECT 1 AS yes FROM messages WHERE channel = 'email' LIMIT 1").get();

  const total = tried.sent + tried.failed;
  const failureRate = total === 0 ? null : tried.failed / total;
  const { state, provider, problems, productionMarketplace, blocksAccountEmail, syntheticLog } = emailConfigState(env);
  const deliveryCheck = state === "delivery_verified" ? "verified" : env.MAIL_DELIVERY_VERIFIED?.trim() ? "other" : "none";
  const oldestMinutes = waiting.n === 0 ? null : waiting.oldest;
  const warnings: EmailWarning[] = [];
  if (state !== "configured_unverified" && state !== "delivery_verified") warnings.push("cannot_deliver");
  if (state === "configured_unverified") warnings.push("unverified");
  if (total >= FAILING_MIN_TRIES && failureRate !== null && failureRate >= FAILING_SHARE) warnings.push("failing");
  if (oldestMinutes !== null && oldestMinutes >= BACKLOG_MINUTES) warnings.push("backlog");
  if (given.security > 0 || waiting.security_failed > 0) warnings.push("security_mail");
  return {
    config: { state, provider, problems, productionMarketplace, blocksAccountEmail, syntheticLog, deliveryCheck },
    lastHour: { sent: tried.sent, failed: tried.failed, failureRate },
    lastDay: { sent: tried.sent_day, failed: tried.failed_day, lastSentAt: tried.last_sent ?? null },
    queued: { count: waiting.n, oldestMinutes },
    givenUp24h: { total: given.total, security: given.security, securityAllowance: given.allowance, securityExpired: given.expired },
    securityRetrying: waiting.security_failed,
    recentFailures: [...grouped.values()].slice(0, 5),
    openAlerts: alerts.map((a) => ({ key: a.key, subject: a.subject, subjectPhrase: subjectPhraseOf(a.said), count: a.count, lastAt: a.last_at })),
    warnings,
    thresholds: { failingMinTries: FAILING_MIN_TRIES, failingShare: FAILING_SHARE, backlogMinutes: BACKLOG_MINUTES },
    noData: !any,
  };
}

/** The subject phrase kept with an alert (lib/alerts.ts), read back; anything unusable reads as none. */
function subjectPhraseOf(raw: string | null): StaffText | null {
  try {
    const v = raw ? (JSON.parse(raw) as { subject?: unknown }) : {};
    return isStaffText(v.subject) ? v.subject : null;
  } catch {
    return null;
  }
}

/** The problem an owner is told about for a configuration, or null when there is none to tell (verified, or a development install). */
export function configProblemAlert(config: EmailConfigState, env: Env = process.env): { key: "blocked" | "warn" | "unverified"; problems: string; provider: string } | null {
  if (config.state === "delivery_verified") return null;
  // A development or test machine is not an install anybody is told about; production (marketplace or not) is.
  if (env.NODE_ENV !== "production") return null;
  const problems = config.problems.join(" ");
  if (config.state === "configured_unverified") return { key: "unverified", problems, provider: config.provider === "ses" ? "Amazon SES" : "SMTP" };
  return { key: config.blocksAccountEmail ? "blocked" : "warn", problems, provider: "" };
}

/**
 * Tell the owners (an alert, cleared once it is right) and answer what the start-up log should say, if email is not set up as a
 * production install needs it: an error while sign-up and forgotten-password requests are being refused, a warning for an install
 * where they are not (a venue's own install, synthetic data) or whose delivery has not been verified. Never throws.
 */
export async function checkEmailConfiguration(env: Env = process.env): Promise<{ level: "error" | "warn"; message: string } | null> {
  const config = emailConfigState(env);
  const problem = configProblemAlert(config, env);
  try {
    const { raiseAlert, clearAlert } = await import("./alerts");
    if (!problem) await clearAlert("config:email");
    else {
      const detail = said(`srv.email.${problem.key}.detail`, problem.key === "unverified" ? { provider: problem.provider } : { problems: problem.problems });
      await raiseAlert("config:email", said(`srv.email.${problem.key}.alert`), englishOf(detail), [detail]);
    }
  } catch {
    // The log line is the courtesy that remains.
  }
  if (config.blocksAccountEmail)
    return { level: "error", message: `Email cannot deliver (${config.state}), so sign-up and forgotten-password requests are refused with "temporarily unavailable". ${config.problems.join(" ")}` };
  if (!problem) return null;
  return {
    level: "warn",
    message:
      problem.key === "unverified"
        ? `Email is configured (${problem.provider}) but delivery has not been verified: run node scripts/verify-integrations.mjs email --send, confirm the inbox, then set MAIL_DELIVERY_VERIFIED. Until then sign-up and password reset may not reach people.`
        : `Email is not set up properly (${config.state}). ${problem.problems}`,
  };
}

let lastChecked = 0;

/**
 * The periodic look the scheduler takes (after each outbox pass, at most every five minutes): the provider failing and mail piling up
 * are alerts to the owners, cleared when they stop; the configuration problem is re-checked too, so one fixed without a restart
 * clears. Never throws.
 */
export async function checkEmailHealth(now = Date.now(), env: Env = process.env): Promise<void> {
  if (now - lastChecked < 5 * 60_000) return;
  lastChecked = now;
  try {
    const { raiseAlert, clearAlert } = await import("./alerts");
    await checkEmailConfiguration(env);
    const health = await emailHealth(env);
    const { sent, failed, failureRate } = health.lastHour;
    if (failed + sent >= FAILING_MIN_TRIES && failureRate !== null && failureRate >= FAILING_SHARE) {
      const row = (await getDb()
        .prepare("SELECT last_error FROM messages WHERE channel = 'email' AND status = 'failed' AND last_attempt_at >= datetime('now', '-1 hour') ORDER BY last_attempt_at DESC LIMIT 1")
        .get()) as { last_error: string | null } | undefined;
      // The provider's words without the recipient's address, a link or a secret (`sanitizedReason`): the alert goes by email and to the webhook.
      const detail = said("srv.email.failing.detail", { failed, total: failed + sent, error: row?.last_error ? sanitizedReason(row.last_error, env) : said("srv.alert.noneGiven") });
      await raiseAlert("email:failing", said("srv.email.failing.alert"), englishOf(detail), [detail]);
    } else await clearAlert("email:failing");
    if (health.queued.oldestMinutes !== null && health.queued.oldestMinutes >= BACKLOG_MINUTES) {
      const detail = said("srv.email.backlog.detail", { minutes: health.queued.oldestMinutes, queued: health.queued.count });
      await raiseAlert("email:backlog", said("srv.email.backlog.alert"), englishOf(detail), [detail]);
    } else await clearAlert("email:backlog");
  } catch (err) {
    console.error("[mysenam] could not check email health:", err instanceof Error ? err.message : "unknown error");
  }
}

/** Tests: forget when the periodic look last ran. */
export function resetEmailHealthClock(): void {
  lastChecked = 0;
}
