import { getDb } from "./db";
import { emailConfigState, type EmailConfigState, type Env } from "./email-config";
import { englishOf, said } from "./staff-text";

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

export interface EmailHealth {
  config: Pick<EmailConfigState, "state" | "provider" | "problems" | "productionMarketplace" | "blocksAccountEmail" | "syntheticLog">;
  /** Email messages tried in the last hour: those the provider accepted, those it refused or did not answer, and the share refused. */
  lastHour: { sent: number; failed: number; failureRate: number | null };
  /** Email waiting to go (queued, or failed and to be tried again; not a venue's bulk news, which waits its turn by design), and the age of the oldest in minutes. */
  queued: { count: number; oldestMinutes: number | null };
  /** Email given up (not sent) in the last day, with security mail (`auth_email`) counted apart and the part of it held by the allowance. */
  givenUp24h: { total: number; security: number; securityAllowance: number };
}

export async function emailHealth(env: Env = process.env): Promise<EmailHealth> {
  const db = getDb();
  const tried = (await db
    .prepare(
      `SELECT (COUNT(*) FILTER (WHERE status = 'sent'))::int AS sent, (COUNT(*) FILTER (WHERE status = 'failed'))::int AS failed
         FROM messages WHERE channel = 'email' AND last_attempt_at >= datetime('now', '-1 hour')`
    )
    .get()) as { sent: number; failed: number };
  const waiting = (await db
    .prepare(
      `SELECT COUNT(*)::int AS n,
              MAX(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'utc') - created_at::timestamp)) / 60)::int AS oldest
         FROM messages
        WHERE channel = 'email' AND status IN ('queued', 'failed') AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND kind NOT IN ('campaign', 'review_request')`
    )
    .get()) as { n: number; oldest: number | null };
  const given = (await db
    .prepare(
      `SELECT COUNT(*)::int AS total,
              (COUNT(*) FILTER (WHERE kind = 'auth_email'))::int AS security,
              (COUNT(*) FILTER (WHERE kind = 'auth_email' AND COALESCE(last_error, '') LIKE 'Not sent: already %'))::int AS allowance
         FROM messages WHERE channel = 'email' AND status = 'abandoned' AND created_at >= datetime('now', '-1 day')`
    )
    .get()) as { total: number; security: number; allowance: number };
  const total = tried.sent + tried.failed;
  const { state, provider, problems, productionMarketplace, blocksAccountEmail, syntheticLog } = emailConfigState(env);
  return {
    config: { state, provider, problems, productionMarketplace, blocksAccountEmail, syntheticLog },
    lastHour: { sent: tried.sent, failed: tried.failed, failureRate: total === 0 ? null : tried.failed / total },
    queued: { count: waiting.n, oldestMinutes: waiting.n === 0 ? null : waiting.oldest },
    givenUp24h: { total: given.total, security: given.security, securityAllowance: given.allowance },
  };
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
      const detail = said("srv.email.failing.detail", { failed, total: failed + sent, error: row?.last_error ?? said("srv.alert.noneGiven") });
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
