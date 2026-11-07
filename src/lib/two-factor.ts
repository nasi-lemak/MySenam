import crypto from "crypto";
import QRCode from "qrcode";
import { getDb } from "./db";
import { isMarketplace } from "./mode";
import { keyedHash, seal, unseal } from "./secrets";
import { siteName } from "./site";

/**
 * Two-factor sign-in for staff: after the password, a six-digit code from an
 * authenticator app (Google Authenticator, 1Password, Authy…), RFC 6238.
 *
 * Staff accounts can change payment keys, refund money and see every
 * customer's number, so a password alone is a thin door. Each account turns
 * it on for itself; `MYSENAM_STAFF_2FA` makes it compulsory ("owners",
 * "managers" — owners and managers — or "all"), in which case an account
 * without it can sign in only to set it up.
 *
 * On a production marketplace it is compulsory for the platform owner, business managers and venue managers (front desk may choose)
 * without anything being set, and `off` cannot undo that (`staffTwoFactor`, ADR 0064). An account without it is signed in to enrol and
 * nothing else, whatever session it had before the rule applied.
 *
 * Every attempt at a code is counted before the code is looked at (`countAttempt`), per account and address, in the database, so
 * parallel guesses cannot outrun the limit; every limit ends by itself (docs/architecture/authentication.md#two-factor-sign-in).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, for a phone clock a little off. */
const DRIFT_STEPS = 1;
const RECOVERY_CODES = 10;
const TICKET_MINUTES = 5;
const TICKET_ATTEMPTS = 5;
/** Attempts at a code from one address for one account in a window, and across every address for the account. */
export const ADDRESS_ATTEMPTS = 10;
export const ADDRESS_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_ATTEMPTS = 50;
export const ACCOUNT_WINDOW_MS = 60 * 60_000;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for a time step (RFC 4226's truncation of an HMAC-SHA1). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const n = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** The step this code belongs to, if it is right now (give or take a step) and newer than the last used. */
export function matchStep(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const s = step + d;
    if (s <= lastStep) continue;
    const expected = totpCode(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

interface Row {
  id: number;
  email: string;
  venue_id: number | null;
  business_id: number | null;
  role: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | string;
  recovery_codes: string | null;
  password_hash: string;
}

async function row(adminId: number): Promise<Row | null> {
  return ((await getDb()
    .prepare(
      "SELECT id, email, venue_id, business_id, role, totp_secret, totp_pending, totp_enabled_at, totp_last_step, recovery_codes, password_hash FROM admins WHERE id = ?"
    )
    .get(adminId)) as Row | undefined) ?? null;
}

const hashRecovery = (code: string) => keyedHash("recovery", code.replace(/[\s-]/g, "").toLowerCase());

export type TwoFactorRule = "off" | "owners" | "managers" | "all";
const SAID_OFF = new Set(["off", "none", "false", "0", "no"]);

export interface StaffTwoFactorSetting {
  /** Who must have it, as it is enforced now. */
  rule: TwoFactorRule;
  /** What `MYSENAM_STAFF_2FA` says, trimmed and lower case ("" when unset). */
  configured: string;
  /** On by the production marketplace's own default, whatever is configured. */
  byDefault: boolean;
  /** Set where it cannot be honoured, and what is done instead; null when the setting is fine. Shown at start-up and raised as an alert. */
  refused: string | null;
  /** Switched off, on a install that says it holds synthetic data only: honoured, and said loudly. */
  offSynthetic: boolean;
}

/**
 * Who must have two-factor sign-in on this install, from `MYSENAM_STAFF_2FA` and where it runs (ADR 0064).
 *
 * - Not a production marketplace (a development machine, the tests, an install of one venue's own): as configured; unset, each account
 *   chooses. This is the override for development and tests, and nothing here changes it.
 * - A **production marketplace**: at least `managers` (the platform owner, business managers, branch managers; front desk may choose),
 *   whatever is set. `all` stays `all`, `owners` is raised to `managers`, and `off`, or a value that is not one of the rules (a typo),
 *   is refused: enforcement carries on at `managers`, and `refused` says so for the start-up log and the owners' alert. The only way a
 *   production marketplace runs without it is `MYSENAM_SYNTHETIC_DATA=on` with it off, for a staging or acceptance install that holds
 *   synthetic data and nobody's real account (AGENTS.md); that is honoured and flagged all the same.
 */
export function staffTwoFactor(): StaffTwoFactorSetting {
  const configured = (process.env.MYSENAM_STAFF_2FA ?? "").trim().toLowerCase();
  const asked: TwoFactorRule | "invalid" | null =
    configured === "" ? null : configured === "owners" || configured === "managers" || configured === "all" ? configured : SAID_OFF.has(configured) ? "off" : "invalid";
  const production = process.env.NODE_ENV === "production" && isMarketplace();
  if (!production) return { rule: asked === null || asked === "invalid" ? "off" : asked, configured, byDefault: false, refused: null, offSynthetic: false };
  const synthetic = (process.env.MYSENAM_SYNTHETIC_DATA ?? "").trim().toLowerCase() === "on";
  if (asked === "off" && synthetic) return { rule: "off", configured, byDefault: false, refused: null, offSynthetic: true };
  const rule: TwoFactorRule = asked === "all" ? "all" : "managers";
  const refused =
    asked === "off"
      ? "MYSENAM_STAFF_2FA is off on a production marketplace. That is refused: the platform owner, business managers and venue managers must still have two-factor sign-in. Remove the setting (or set it to managers or all)."
      : asked === "invalid"
        ? `MYSENAM_STAFF_2FA is "${configured}", which is not owners, managers or all. It is not read as off: the platform owner, business managers and venue managers must still have two-factor sign-in. Correct the setting.`
        : null;
  return { rule, configured, byDefault: asked !== "all" && asked !== "managers", refused, offSynthetic: false };
}

/** Whether this account must have two-factor sign-in, by the install's rule. */
export function twoFactorRequired(admin: { venueId: number | null; businessId: number | null; role: string }): boolean {
  const { rule } = staffTwoFactor();
  const owner = admin.venueId === null && admin.businessId === null;
  if (rule === "all") return true;
  if (rule === "managers") return owner || admin.role !== "desk";
  if (rule === "owners") return owner;
  return false;
}

/** Tell the log and the owners if the install's two-factor setting was refused, and clear the alert once it is right. Never throws. */
export async function checkStaffTwoFactorSetting(): Promise<string | null> {
  const { refused, offSynthetic } = staffTwoFactor();
  try {
    const { raiseAlert, clearAlert } = await import("./alerts");
    if (refused) await raiseAlert("config:staff-2fa", "Staff two-factor sign-in is misconfigured and is being kept on", refused);
    else if (offSynthetic)
      await raiseAlert("config:staff-2fa", "Staff two-factor sign-in is off on a production marketplace (MYSENAM_SYNTHETIC_DATA=on)", "This is for staging and acceptance installs holding synthetic data only. If this install has real venues or customers, remove MYSENAM_STAFF_2FA=off now.");
    else await clearAlert("config:staff-2fa");
  } catch {
    // The log line is the courtesy that remains.
  }
  return refused;
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryLeft: number;
  required: boolean;
}

export async function twoFactorStatus(admin: { id: number; venueId: number | null; businessId: number | null; role: string }): Promise<TwoFactorStatus> {
  const r = await row(admin.id);
  return {
    enabled: Boolean(r?.totp_enabled_at),
    enabledAt: r?.totp_enabled_at ?? null,
    recoveryLeft: r?.recovery_codes ? (JSON.parse(r.recovery_codes) as string[]).length : 0,
    required: twoFactorRequired(admin),
  };
}

/** A new secret for the authenticator app, kept aside until a code from it proves it was scanned. */
export async function startSetup(adminId: number): Promise<{ secret: string; uri: string; qr: string } | null> {
  const r = await row(adminId);
  if (!r) return null;
  const secret = base32Encode(crypto.randomBytes(20));
  await getDb().prepare("UPDATE admins SET totp_pending = ? WHERE id = ?").run(seal(secret), adminId);
  const issuer = siteName();
  const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${r.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${DIGITS}&period=${STEP_SECONDS}`;
  return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

function newRecoveryCodes(): { shown: string[]; stored: string[] } {
  const shown = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = crypto.randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { shown, stored: shown.map(hashRecovery) };
}

/** A code from the newly scanned app turns it on; the recovery codes are shown this once. */
export async function confirmSetup(adminId: number, code: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
  const r = await row(adminId);
  const pending = r?.totp_pending ? unseal(r.totp_pending) : null;
  if (!r || !pending) return { ok: false, error: "Start again: scan the new code first." };
  const step = matchStep(base32Decode(pending), code, 0);
  if (step === null) return { ok: false, error: "That code is not right. Check the phone's clock, and type the six digits showing now." };
  const { shown, stored } = newRecoveryCodes();
  await getDb()
    .prepare(
      `UPDATE admins SET totp_secret = ?, totp_pending = NULL, totp_enabled_at = datetime('now'), totp_last_step = ?, recovery_codes = ?
        WHERE id = ?`
    )
    .run(seal(pending), step, JSON.stringify(stored), adminId);
  return { ok: true, recoveryCodes: shown };
}

/** One bump of a counter, atomic: the count it reached, and when its window ends. */
async function bump(adminId: number, key: string, windowMs: number, now: number): Promise<{ attempts: number; resetAt: number }> {
  const row = (await getDb()
    .prepare(
      `INSERT INTO admin_two_factor_attempts (admin_id, address_key, attempts, reset_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (admin_id, address_key) DO UPDATE SET
         attempts = CASE WHEN admin_two_factor_attempts.reset_at <= ? THEN 1 ELSE admin_two_factor_attempts.attempts + 1 END,
         reset_at = CASE WHEN admin_two_factor_attempts.reset_at <= ? THEN excluded.reset_at ELSE admin_two_factor_attempts.reset_at END
       RETURNING attempts, reset_at`
    )
    .get(adminId, key, now + windowMs, now, now)) as { attempts: number | string; reset_at: number | string };
  return { attempts: Number(row.attempts), resetAt: Number(row.reset_at) };
}

/**
 * Count an attempt at this account's code, before the code is looked at, and say whether it may go on. Two counters, each one atomic
 * upsert: this address for this account (`ADDRESS_ATTEMPTS` in `ADDRESS_WINDOW_MS`), then the account from anywhere
 * (`ACCOUNT_ATTEMPTS` in `ACCOUNT_WINDOW_MS`). An attempt past a limit is refused and the code is not checked, so parallel guesses cannot
 * outrun it; a refused attempt from an address does not count against the account, so one address cannot lock everybody out. Both end by
 * themselves when their window does (the window is fixed: failing again does not extend it).
 */
export async function countAttempt(adminId: number, address: string, now = Date.now()): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const key = keyedHash("2fa-address", address || "unknown");
  const own = await bump(adminId, key, ADDRESS_WINDOW_MS, now);
  if (own.attempts > ADDRESS_ATTEMPTS) return { allowed: false, retryAfter: Math.max(1, Math.ceil((own.resetAt - now) / 1000)) };
  const all = await bump(adminId, "*", ACCOUNT_WINDOW_MS, now);
  if (all.attempts > ACCOUNT_ATTEMPTS) return { allowed: false, retryAfter: Math.max(1, Math.ceil((all.resetAt - now) / 1000)) };
  return { allowed: true };
}

/** A right code: this address starts again, and the account is given its attempt back. Only ever after a code was right. */
async function forgiveAttempt(adminId: number, address: string): Promise<void> {
  const db = getDb();
  await db.prepare("DELETE FROM admin_two_factor_attempts WHERE admin_id = ? AND address_key = ?").run(adminId, keyedHash("2fa-address", address || "unknown"));
  await db.prepare("UPDATE admin_two_factor_attempts SET attempts = GREATEST(attempts - 1, 0) WHERE admin_id = ? AND address_key = '*'").run(adminId);
}

/** The code itself: right now (one step either side, newer than the last used), or a recovery code not yet used. Uses it up. */
async function codeIsRight(adminId: number, code: string): Promise<boolean> {
  const r = await row(adminId);
  if (!r?.totp_enabled_at || !r.totp_secret) return false;
  const secret = unseal(r.totp_secret);
  const db = getDb();
  if (secret) {
    const step = matchStep(base32Decode(secret), code, Number(r.totp_last_step));
    if (step !== null) {
      // Only if nobody used a newer step meanwhile: the same code twice fails.
      const done = await db.prepare("UPDATE admins SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, adminId, step);
      return done.changes === 1;
    }
  }
  const codes = r.recovery_codes ? (JSON.parse(r.recovery_codes) as string[]) : [];
  const hashed = hashRecovery(code);
  if (!codes.includes(hashed)) return false;
  const left = codes.filter((c) => c !== hashed);
  const done = await db
    .prepare("UPDATE admins SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?")
    .run(JSON.stringify(left), adminId, r.recovery_codes);
  return done.changes === 1;
}

export type SecondFactorCheck = { ok: true } | { ok: false; locked: false } | { ok: false; locked: true; retryAfter: number };

/**
 * Check a code from the app, or one of the recovery codes (each good once), counting the attempt first (`countAttempt`). `address` is where the
 * request came from (lib/rate-limit.ts `clientAddress`); one caller that has none shares an address of its own.
 */
export async function verifySecondFactor(adminId: number, code: string, address = ""): Promise<SecondFactorCheck> {
  const counted = await countAttempt(adminId, address);
  if (!counted.allowed) return { ok: false, locked: true, retryAfter: counted.retryAfter };
  if (!(await codeIsRight(adminId, code))) return { ok: false, locked: false };
  await forgiveAttempt(adminId, address);
  return { ok: true };
}

/** True when the code is right (and used up), counted and limited as `verifySecondFactor` says. */
export async function checkSecondFactor(adminId: number, code: string, address = ""): Promise<boolean> {
  return (await verifySecondFactor(adminId, code, address)).ok;
}

/** An account's attempt counters cleared: after its two-factor sign-in was reset by somebody with authority over it. */
export async function clearAttempts(adminId: number): Promise<void> {
  await getDb().prepare("DELETE FROM admin_two_factor_attempts WHERE admin_id = ?").run(adminId);
}

/** Turn it off, with a current code (or a recovery code) to show it is the owner of the account doing so. */
export async function disableTwoFactor(
  admin: { id: number; venueId: number | null; businessId: number | null; role: string },
  code: string,
  address = ""
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (twoFactorRequired(admin)) return { ok: false, error: "Two-factor sign-in is required for this account here." };
  if (!(await checkSecondFactor(admin.id, code, address))) return { ok: false, error: "That code is not right." };
  await getDb()
    .prepare("UPDATE admins SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = ?")
    .run(admin.id);
  return { ok: true };
}

/** New recovery codes, the old ones void: when they are used up or may have been seen. */
export async function renewRecoveryCodes(adminId: number, code: string, address = ""): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
  if (!(await checkSecondFactor(adminId, code, address))) return { ok: false, error: "That code is not right." };
  const { shown, stored } = newRecoveryCodes();
  await getDb().prepare("UPDATE admins SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(stored), adminId);
  return { ok: true, recoveryCodes: shown };
}

/** Whether the account has two-factor on, for the sign-in step. */
export async function hasTwoFactor(adminId: number): Promise<boolean> {
  return Boolean((await row(adminId))?.totp_enabled_at);
}

/** Password right: a short-lived ticket to bring back with the code. */
export async function issueLoginTicket(adminId: number): Promise<string> {
  const db = getDb();
  await db.prepare("DELETE FROM admin_login_tickets WHERE expires_at < ?").run(new Date().toISOString());
  const token = crypto.randomBytes(24).toString("hex");
  await db
    .prepare("INSERT INTO admin_login_tickets (token, admin_id, expires_at) VALUES (?, ?, ?)")
    .run(token, adminId, new Date(Date.now() + TICKET_MINUTES * 60_000).toISOString());
  return token;
}

const TICKET_GONE = "That sign-in has timed out. Enter your password again.";

/**
 * The ticket and a right code: whose sign-in it completes. The attempt is counted on the ticket first, in the one statement that takes
 * it (so parallel requests cannot all pass the cap before any is counted), and on the account and address next (`countAttempt`); only
 * then is the code looked at. A ticket is good for `TICKET_ATTEMPTS` tries and five minutes and for one sign-in: it is used up by the
 * first right code, and a second request holding it, however close behind, is turned away. Wrong, expired, used and unknown tickets
 * are answered alike, and nothing says whether the account exists or which factor it has.
 */
export async function redeemLoginTicket(
  token: string,
  code: string,
  address = ""
): Promise<{ ok: true; adminId: number } | { ok: false; error: string; locked?: boolean; retryAfter?: number }> {
  const db = getDb();
  const claimed = (await db
    .prepare("UPDATE admin_login_tickets SET attempts = attempts + 1 WHERE token = ? AND expires_at >= ? AND attempts < ? RETURNING admin_id, attempts")
    .get(token, new Date().toISOString(), TICKET_ATTEMPTS)) as { admin_id: number; attempts: number } | undefined;
  if (!claimed) return { ok: false, error: TICKET_GONE };
  const verdict = await verifySecondFactor(claimed.admin_id, code, address);
  if (verdict.ok) {
    // Used up by taking it: of two requests with a right code, one signs in.
    const taken = await db.prepare("DELETE FROM admin_login_tickets WHERE token = ? RETURNING admin_id").get(token);
    return taken ? { ok: true, adminId: claimed.admin_id } : { ok: false, error: TICKET_GONE };
  }
  if (claimed.attempts >= TICKET_ATTEMPTS) await db.prepare("DELETE FROM admin_login_tickets WHERE token = ?").run(token);
  if (verdict.locked) return { ok: false, error: "Too many attempts. Please wait a moment and try again.", locked: true, retryAfter: verdict.retryAfter };
  return { ok: false, error: "That code is not right." };
}
