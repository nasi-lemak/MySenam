import crypto from "crypto";
import { getDb } from "./db";
import { ensureBootstrapAdmin } from "./admin-auth";
import { hashPassword, sessionKey, verifyPassword } from "./auth";
import { keyedHash } from "./secrets";
import { baseUrl, drainOutbox, emailPlain } from "./outbox";
import { siteName } from "./site";
import { errorText, translator, type ErrorCode, type Locale } from "./i18n";

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
 * used to find out who is a customer. An account may ask three times an hour.
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

/** Email a link to set a new password, if the address has an account. Always "ok". */
export async function requestReset(kind: AccountKind, email: string, locale: Locale = "en"): Promise<{ ok: true }> {
  // As signing in does: on a fresh install the first owner exists from the start.
  if (kind === "admin") await ensureBootstrapAdmin();
  const db = getDb();
  const t = TABLES[kind];
  const account = (await db.prepare(`SELECT id, name, email FROM ${t.accounts} WHERE email = ?`).get(email.trim())) as
    | { id: number; name: string; email: string }
    | undefined;
  if (!account) return { ok: true };
  await db.prepare("DELETE FROM password_resets WHERE created_at < datetime('now', '-1 day')").run();
  const { n } = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM password_resets WHERE kind = ? AND account_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(kind, account.id)) as { n: number };
  if (n >= RESETS_PER_HOUR) return { ok: true };
  const token = crypto.randomBytes(24).toString("base64url");
  await db
    .prepare(
      `INSERT INTO password_resets (kind, account_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+${RESET_MINUTES} minutes'))`
    )
    .run(kind, account.id, hashOf(token));
  const tr = translator(kind === "admin" ? "en" : locale);
  const link = `${baseUrl()}/reset-password?kind=${kind}&token=${token}`;
  // Queued, so a mail server that is down delays the link rather than losing
  // it; not sent once the link has run out, and never sent again to another
  // address. The sending is not awaited: a reply that took as long as sending
  // an email would say the address has an account.
  await emailPlain({
    to: account.email,
    subject: tr("reset.emailSubject", { site: siteName() }),
    text: tr("reset.emailBody", { name: account.name.split(/\s+/)[0], link, minutes: RESET_MINUTES }),
    kind: "account_email",
    expiresMinutes: RESET_MINUTES,
  });
  void drainOutbox().catch(() => null);
  return { ok: true };
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
