import crypto from "crypto";
import { getDb } from "./db";
import { ensureBootstrapAdmin } from "./admin-auth";
import { hashPassword, sessionKey, verifyPassword } from "./auth";
import { keyedHash } from "./secrets";
import { baseUrl, drainOutbox, emailPlain } from "./outbox";
import { siteName } from "./site";
import { errorText, isLocale, translator, type ErrorCode, type Locale } from "./i18n";
import { linkIn } from "./link-locale";

/**
 * Forgotten passwords, for customers and for venue staff.
 *
 * Without this, every forgotten password is a message to whoever runs the
 * site. "Forgot password?" emails a link that sets a new one: it works once,
 * for 30 minutes, and only a keyed hash of it is stored, so a copy of the
 * database cannot be used to take an account over. Setting a new password
 * signs the account out everywhere else — whoever had it no longer does.
 *
 * Asking never says whether an address has an account, so the form cannot be
 * used to find out who is a customer, nor does how long it takes to answer:
 * the request is queued and worked through afterwards. An account may ask
 * three times an hour.
 *
 * Signed in, a password can be changed by giving the current one (or set,
 * for an account made with Google that has none); the account's other
 * sessions end.
 */

export type AccountKind = "user" | "admin";

export const RESET_MINUTES = 30;
export const RESETS_PER_HOUR = 3;
export const MIN_PASSWORD = 8;

const TABLES: Record<AccountKind, { accounts: string; sessions: string; sessionColumn: string }> = {
  user: { accounts: "users", sessions: "sessions", sessionColumn: "user_id" },
  admin: { accounts: "admins", sessions: "admin_sessions", sessionColumn: "admin_id" },
};

const hashOf = (token: string) => keyedHash("password-reset", token);

/**
 * Email a link to set a new password, if the address has an account. Always
 * "ok", and the reply waits only on writing the request down: the same work
 * whether or not an account holds the address. Finding the account, making
 * the link and queuing its email happen after the reply
 * (`processResetRequests`), so how long it takes does not say either.
 */
export async function requestReset(kind: AccountKind, email: string, locale: Locale = "en"): Promise<{ ok: true }> {
  // As signing in does: on a fresh install the first owner exists from the start.
  if (kind === "admin") await ensureBootstrapAdmin();
  await getDb()
    .prepare("INSERT INTO password_reset_requests (kind, email, locale) VALUES (?, ?, ?)")
    .run(kind, email.trim().slice(0, 320), kind === "admin" ? "en" : locale);
  workThroughSoon();
  return { ok: true };
}

/** The requests this process is working through, one run after another. */
let working: Promise<void> = Promise.resolve();

/**
 * Work through the queued requests once the reply has gone, and send what
 * they queue. Started on a later turn of the event loop, so none of it runs
 * before the reply; whatever this misses, the scheduler picks up
 * (lib/notify.ts, tickOutbox).
 */
function workThroughSoon(): void {
  working = working
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(() => processResetRequests())
    .then(() => drainOutbox())
    .then(
      () => undefined,
      () => undefined
    );
}

/** Wait for the requests this process has started working through. */
export async function settleResetRequests(): Promise<void> {
  await working;
}

/**
 * Work through queued requests: each is taken once (two servers at once take
 * different ones) and, where an account holds the address, a link is made and
 * its email queued, at most RESETS_PER_HOUR an hour. A request older than a
 * link's life is dropped unsent. Answers how many links were made.
 */
export async function processResetRequests(limit = 25): Promise<number> {
  const db = getDb();
  const taken = (await db
    .prepare(
      `DELETE FROM password_reset_requests WHERE id IN (
         SELECT id FROM password_reset_requests ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, email, locale, created_at >= datetime('now', '-${RESET_MINUTES} minutes') AS fresh`
    )
    .all(limit)) as { id: number; kind: AccountKind; email: string; locale: string; fresh: boolean }[];
  let made = 0;
  for (const r of taken.sort((a, b) => a.id - b.id))
    if (r.fresh && (await sendResetLink(r.kind, r.email, isLocale(r.locale) ? r.locale : "en"))) made++;
  return made;
}

/** The work only a request for an account's address does: a link made and its email queued. */
async function sendResetLink(kind: AccountKind, email: string, locale: Locale): Promise<boolean> {
  const db = getDb();
  const t = TABLES[kind];
  const account = (await db.prepare(`SELECT id, name, email FROM ${t.accounts} WHERE email = ?`).get(email.trim())) as
    | { id: number; name: string; email: string }
    | undefined;
  if (!account) return false;
  await db.prepare("DELETE FROM password_resets WHERE created_at < datetime('now', '-1 day')").run();
  const { n } = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM password_resets WHERE kind = ? AND account_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(kind, account.id)) as { n: number };
  if (n >= RESETS_PER_HOUR) return false;
  const token = crypto.randomBytes(24).toString("base64url");
  await db
    .prepare(
      `INSERT INTO password_resets (kind, account_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+${RESET_MINUTES} minutes'))`
    )
    .run(kind, account.id, hashOf(token));
  const tr = translator(kind === "admin" ? "en" : locale);
  // A customer's opens in the language they asked in (lib/link-locale.ts); staff have their own.
  const link = kind === "admin" ? `${baseUrl()}/reset-password?kind=${kind}&token=${token}` : linkIn(`${baseUrl()}/reset-password?kind=${kind}&token=${token}`, locale);
  // Queued, so a mail server that is down delays the link rather than losing
  // it; not sent once the link has run out, and never sent again to another
  // address.
  await emailPlain({
    to: account.email,
    subject: tr("reset.emailSubject", { site: siteName() }),
    text: tr("reset.emailBody", { name: account.name.split(/\s+/)[0], link, minutes: RESET_MINUTES }),
    kind: "account_email",
    expiresMinutes: RESET_MINUTES,
  });
  return true;
}

type Refusal = { ok: false; error: string; code: ErrorCode; vars?: Record<string, number> };
export type ResetResult = { ok: true; accountId: number } | Refusal;

const ENGLISH = translator("en");

function refuse(code: ErrorCode, vars?: Record<string, number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

function weak(password: string): Refusal | null {
  if (password.length < MIN_PASSWORD || password.length > 200) return refuse("PASSWORD_WEAK", { n: MIN_PASSWORD });
  return null;
}

/** Set a new password with an emailed link, and sign the account out everywhere. */
export async function resetPassword(kind: AccountKind, token: string, password: string): Promise<ResetResult> {
  const bad = weak(password);
  if (bad) return bad;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return refuse("RESET_INVALID");
  const db = getDb();
  const t = TABLES[kind];
  return db.transaction(async (): Promise<ResetResult> => {
    const claimed = (await db
      .prepare(
        `UPDATE password_resets SET used_at = datetime('now')
          WHERE kind = ? AND token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
          RETURNING account_id`
      )
      .get(kind, hashOf(token))) as { account_id: number } | undefined;
    if (!claimed) return refuse("RESET_INVALID");
    await db.prepare(`UPDATE ${t.accounts} SET password_hash = ? WHERE id = ?`).run(hashPassword(password), claimed.account_id);
    // The link went to the account's address, so whoever set this password holds it (lib/oauth.ts keeps it).
    if (kind === "user")
      await db.prepare("UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, datetime('now')) WHERE id = ?").run(claimed.account_id);
    await db.prepare(`DELETE FROM ${t.sessions} WHERE ${t.sessionColumn} = ?`).run(claimed.account_id);
    // Any other links still out for this account are void now too.
    await db
      .prepare("UPDATE password_resets SET used_at = datetime('now') WHERE kind = ? AND account_id = ? AND used_at IS NULL")
      .run(kind, claimed.account_id);
    return { ok: true, accountId: claimed.account_id };
  })();
}

/**
 * Change the password while signed in. The current one is needed, except by
 * an account that has none (made with Google). Every other session ends; the
 * one making the change stays signed in.
 */
export async function changePassword(
  kind: AccountKind,
  accountId: number,
  current: string,
  next: string,
  keepToken: string | null
): Promise<{ ok: true } | Refusal | { ok: false; error: string }> {
  const bad = weak(next);
  if (bad) return bad;
  const db = getDb();
  const t = TABLES[kind];
  const row = (await db.prepare(`SELECT password_hash FROM ${t.accounts} WHERE id = ?`).get(accountId)) as { password_hash: string } | undefined;
  if (!row) return { ok: false, error: "Not found." };
  if (row.password_hash !== "" && !verifyPassword(current, row.password_hash))
    return refuse("PASSWORD_WRONG");
  await db.prepare(`UPDATE ${t.accounts} SET password_hash = ? WHERE id = ?`).run(hashPassword(next), accountId);
  await db.prepare(`DELETE FROM ${t.sessions} WHERE ${t.sessionColumn} = ? AND token <> ?`).run(accountId, keepToken ? sessionKey(keepToken) : "");
  return { ok: true };
}

/** Whether the account has a password at all (one made with Google may not). */
export async function hasPassword(kind: AccountKind, accountId: number): Promise<boolean> {
  const row = (await getDb().prepare(`SELECT password_hash FROM ${TABLES[kind].accounts} WHERE id = ?`).get(accountId)) as
    | { password_hash: string }
    | undefined;
  return !!row && row.password_hash !== "";
}
