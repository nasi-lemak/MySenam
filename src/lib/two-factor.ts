import crypto from "crypto";
import QRCode from "qrcode";
import { getDb } from "./db";
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
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, for a phone clock a little off. */
const DRIFT_STEPS = 1;
const RECOVERY_CODES = 10;
const TICKET_MINUTES = 5;
const TICKET_ATTEMPTS = 5;

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

/** Whether this account must have two-factor sign-in, by the install's rule. */
export function twoFactorRequired(admin: { venueId: number | null; businessId: number | null; role: string }): boolean {
  const rule = (process.env.MYSENAM_STAFF_2FA ?? "").trim().toLowerCase();
  const owner = admin.venueId === null && admin.businessId === null;
  if (rule === "all") return true;
  if (rule === "managers") return owner || admin.role !== "desk";
  if (rule === "owners") return owner;
  return false;
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

/**
 * Check a code from the app, or one of the recovery codes (each good once).
 * True when it is right; the step or the recovery code is then used up.
 */
export async function checkSecondFactor(adminId: number, code: string): Promise<boolean> {
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

/** Turn it off, with a current code (or a recovery code) to show it is the owner of the account doing so. */
export async function disableTwoFactor(admin: { id: number; venueId: number | null; businessId: number | null; role: string }, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (twoFactorRequired(admin)) return { ok: false, error: "Two-factor sign-in is required for this account here." };
  if (!(await checkSecondFactor(admin.id, code))) return { ok: false, error: "That code is not right." };
  await getDb()
    .prepare("UPDATE admins SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = ?")
    .run(admin.id);
  return { ok: true };
}

/** New recovery codes, the old ones void: when they are used up or may have been seen. */
export async function renewRecoveryCodes(adminId: number, code: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
  if (!(await checkSecondFactor(adminId, code))) return { ok: false, error: "That code is not right." };
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

/** The ticket and a right code: whose sign-in it completes. A few wrong codes and the ticket is gone. */
export async function redeemLoginTicket(token: string, code: string): Promise<{ ok: true; adminId: number } | { ok: false; error: string }> {
  const db = getDb();
  const ticket = (await db
    .prepare("SELECT admin_id, attempts FROM admin_login_tickets WHERE token = ? AND expires_at >= ?")
    .get(token, new Date().toISOString())) as { admin_id: number; attempts: number } | undefined;
  if (!ticket) return { ok: false, error: "That sign-in has timed out. Enter your password again." };
  if (await checkSecondFactor(ticket.admin_id, code)) {
    await db.prepare("DELETE FROM admin_login_tickets WHERE token = ?").run(token);
    return { ok: true, adminId: ticket.admin_id };
  }
  if (ticket.attempts + 1 >= TICKET_ATTEMPTS) await db.prepare("DELETE FROM admin_login_tickets WHERE token = ?").run(token);
  else await db.prepare("UPDATE admin_login_tickets SET attempts = attempts + 1 WHERE token = ?").run(token);
  return { ok: false, error: "That code is not right." };
}
