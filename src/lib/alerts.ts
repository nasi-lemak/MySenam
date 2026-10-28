import { aside, getDb, mustRethrow } from "./db";
import { tellOwnersEach } from "./owner-alerts";
import { siteName } from "./site";
import { englishOf, isStaffText, said, type StaffText } from "./staff-text";

/**
 * Telling the platform owner when something breaks.
 *
 * Without this, a failure is a line in a server log nobody reads: backups
 * quietly stop, confirmations stop going out, a page throws for every
 * customer — and the first anybody hears is a venue's complaint. Each kind of
 * failure has a key; it is told about once, then again only after
 * `RESEND_HOURS` if it is still happening, with how many times it has, so a
 * failure every minute is one email, not a thousand.
 *
 * It goes to every platform owner by email and, when `MYSENAM_ALERT_WEBHOOK`
 * is set, to that address as JSON `{ "text": ... }` — a Slack, Discord or
 * Google Chat incoming webhook, which still arrives when email is what broke.
 */

export const RESEND_HOURS = 6;

export interface SystemAlert {
  key: string;
  subject: string;
  /** The subject as a phrase the dashboard says in the staff language; null for one raised before phrases were kept. */
  subjectPhrase: StaffText | null;
  lastDetail: string | null;
  /** The detail's lines as phrases, when MySenam composed them (not an error's own text). */
  detailPhrases: StaffText[] | null;
  count: number;
  firstAt: string;
  lastAt: string;
  lastSentAt: string | null;
}

/**
 * Note a failure; tell the owners if it is new or has not been told for a while. Never throws.
 * A subject given as a phrase, and the detail's lines when MySenam composed them, are kept so
 * the owner's dashboard says them in the staff language; each owner's email says them in theirs
 * too (an error's own text, and a subject given as English, as given). The webhook says English.
 */
export async function raiseAlert(key: string, about: string | StaffText, detail: string, detailPhrases?: StaffText[]): Promise<boolean> {
  try {
    return await aside(async () => {
      const subject = typeof about === "string" ? about : englishOf(about);
      const phrases = typeof about === "string" ? null : JSON.stringify({ subject: about, ...(detailPhrases ? { detail: detailPhrases } : {}) });
      const db = getDb();
      const row = (await db
        .prepare(
          `INSERT INTO system_alerts (key, subject, last_detail, count, said) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (key) DO UPDATE SET subject = excluded.subject, last_detail = excluded.last_detail, said = excluded.said,
             count = system_alerts.count + 1, last_at = datetime('now')
           RETURNING count, last_sent_at, (last_sent_at IS NULL OR last_sent_at < datetime('now', '-${RESEND_HOURS} hours')) AS due`
        )
        .get(key, subject, detail.slice(0, 2000), phrases)) as { count: number; last_sent_at: string | null; due: boolean };
      if (!row.due) return false;
      // Claimed before sending, so two processes do not both tell it.
      const claimed = await db
        .prepare(
          `UPDATE system_alerts SET last_sent_at = datetime('now')
            WHERE key = ? AND (last_sent_at IS NULL OR last_sent_at < datetime('now', '-${RESEND_HOURS} hours'))`
        )
        .run(key);
      if (claimed.changes === 0) return false;
      await tellOwnersEach((t) => {
        const heading = typeof about === "string" ? about : t.say(about);
        const times = row.count > 1 ? ` ${t("r9d.sys.times", { n: row.count })}` : "";
        const lines = detailPhrases ? detailPhrases.map((p) => t.say(p)).join("\n") : detail;
        return { subject: t("r9d.sys.s", { subject: heading }), body: `${heading}${times}\n\n${lines}\n\n${t("r9d.sys.again", { hours: RESEND_HOURS })}` };
      });
      const times = row.count > 1 ? ` (${row.count} times so far)` : "";
      await postWebhook(`⚠ ${siteName()}: ${subject}${times}\n\n${detail}`);
      return true;
    });
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] could not raise an alert:", err);
    return false;
  }
}

async function postWebhook(text: string): Promise<void> {
  const url = process.env.MYSENAM_ALERT_WEBHOOK?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 3500) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[mysenam] alert webhook failed:", err);
  }
}

/** What has gone wrong lately, newest first, for the owner's dashboard. */
export async function recentAlerts(days = 7): Promise<SystemAlert[]> {
  const rows = (await getDb()
    .prepare(`SELECT * FROM system_alerts WHERE last_at >= datetime('now', '-${Math.round(days) * 24} hours') ORDER BY last_at DESC`)
    .all()) as {
    key: string;
    subject: string;
    last_detail: string | null;
    count: number;
    first_at: string;
    last_at: string;
    last_sent_at: string | null;
    said: string | null;
  }[];
  return rows.map((r) => ({
    key: r.key,
    subject: r.subject,
    ...phrasesOf(r.said),
    lastDetail: r.last_detail,
    count: r.count,
    firstAt: r.first_at,
    lastAt: r.last_at,
    lastSentAt: r.last_sent_at,
  }));
}

/** The phrases kept with an alert, read back; nothing usable reads as none. */
function phrasesOf(raw: string | null): { subjectPhrase: StaffText | null; detailPhrases: StaffText[] | null } {
  try {
    const v = raw ? (JSON.parse(raw) as { subject?: unknown; detail?: unknown }) : {};
    const detail = Array.isArray(v.detail) && v.detail.every(isStaffText) ? (v.detail as StaffText[]) : null;
    return { subjectPhrase: isStaffText(v.subject) ? v.subject : null, detailPhrases: detail };
  } catch {
    return { subjectPhrase: null, detailPhrases: null };
  }
}

/** Clear one once it is dealt with, so the next one is news again. */
export async function clearAlert(key: string): Promise<void> {
  await getDb().prepare("DELETE FROM system_alerts WHERE key = ?").run(key);
}

// ------------------------------------------------------------ what is watched

/**
 * Messages that will not go out: several failures in the last hour and none
 * sent. One bounced address is not news; the email account rejecting
 * everything is.
 */
export async function checkMessages(): Promise<void> {
  const row = (await getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('failed', 'abandoned') THEN 1 ELSE 0 END)::int AS failed,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)::int AS sent,
         MAX(CASE WHEN status IN ('failed', 'abandoned') THEN last_error END) AS error
       FROM messages WHERE created_at >= datetime('now', '-1 hours')`
    )
    .get()) as { failed: number | null; sent: number | null; error: string | null };
  if ((row.failed ?? 0) >= 5 && (row.sent ?? 0) === 0) {
    const detail = said("srv.alert.messagesDetail", { n: row.failed!, error: row.error ?? said("srv.alert.noneGiven") });
    await raiseAlert("messages", said("srv.alert.messages"), englishOf(detail), [detail]);
  }
}

/**
 * A server error on a request: a bug, or something it depends on being down.
 * Filed with its stack under its kind (lib/error-log.ts), which tells the
 * owners about each new kind.
 */
export async function noteRequestError(err: unknown, request: { path: string; method: string; digest?: string }): Promise<void> {
  const { recordError } = await import("./error-log");
  await recordError({
    source: "server",
    name: err instanceof Error ? err.name : "Error",
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? (err.stack ?? null) : null,
    path: request.path,
    method: request.method,
    digest: request.digest ?? (err as { digest?: string } | null)?.digest ?? null,
  });
}

const STARTED = Date.now();
const HEARTBEAT_KEY = "scheduler_heartbeat";

/** The scheduler ticked; stamped so a stalled one can be seen from outside. */
export async function heartbeat(): Promise<void> {
  await getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(HEARTBEAT_KEY);
}

/** Has the scheduler ticked in the last 10 minutes? True too while this process is young. */
export async function schedulerAlive(): Promise<boolean> {
  if (Date.now() - STARTED < 10 * 60_000) return true;
  const row = (await getDb()
    .prepare("SELECT value > datetime('now', '-10 minutes') AS fresh FROM settings WHERE key = ?")
    .get(HEARTBEAT_KEY)) as { fresh: boolean } | undefined;
  return row?.fresh === true;
}
