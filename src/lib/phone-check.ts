import crypto from "crypto";
import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import type { Locale } from "./i18n";
import { keyedHash } from "./secrets";
import { siteName } from "./site";
import { toWhatsAppNumber, whatsappConfig } from "./transports";
import type { Refusal } from "./types";

/**
 * A customer's phone number, checked.
 *
 * Nothing else here can tell a number somebody holds from one they typed:
 * the venue rings it, confirmations go to it, limits and blocks are kept by
 * it, and league box-mates are given it. So an account proves its number
 * once, with a six-digit code sent to it on WhatsApp — which nearly every
 * phone in Malaysia has, and which this install already sends through — and
 * after that it counts as checked until the number on the account changes.
 *
 * On when WhatsApp is set up (or MYSENAM_PHONE_CHECK=on; MYSENAM_SEND=log
 * then writes the code to the server log). Without a way to send a code
 * there is nothing to check with, and a number is taken as given, as before.
 * MYSENAM_PHONE_CHECK=off turns it off regardless.
 *
 * Guests booking without an account are not asked: one court, once, with a
 * name and a number, is what a counter takes too.
 */

export const CODE_MINUTES = 10;
export const MAX_TRIES = 5;
/** Codes one account may ask for in an hour, and one number may be sent in a day. */
export const SENDS_PER_HOUR = 3;
export const SENDS_PER_NUMBER_PER_DAY = 5;

const ENGLISH = translator("en");

export function phoneChecksOn(): boolean {
  const flag = process.env.MYSENAM_PHONE_CHECK;
  if (flag === "off") return false;
  if (flag === "on") return true;
  return whatsappConfig() !== null;
}

/** A number as WhatsApp takes it, or null if it does not look like one. */
export function phoneNumber(phone: string): string | null {
  const trimmed = phone.trim();
  if (!/^\+?[0-9 -]{7,20}$/.test(trimmed)) return null;
  return toWhatsAppNumber(trimmed);
}

export interface PhoneStatus {
  phone: string;
  verified: boolean;
  /** Whether this install checks numbers at all. */
  checks: boolean;
}

export async function phoneStatus(userId: number): Promise<PhoneStatus | null> {
  const row = (await getDb().prepare("SELECT phone, verified_phone FROM users WHERE id = ?").get(userId)) as
    | { phone: string; verified_phone: string | null }
    | undefined;
  if (!row) return null;
  return {
    phone: row.phone,
    verified: row.verified_phone !== null && row.phone !== "" && phoneNumber(row.phone) === row.verified_phone,
    checks: phoneChecksOn(),
  };
}

function refuse(code: ErrorCode): Refusal {
  return { ok: false, error: errorText(ENGLISH, code), code };
}

/**
 * Why this account may not book, join or enter yet, or null if it may:
 * it has no number (signed in with Google), or the number is not checked.
 */
export async function phoneRefusal(userId: number): Promise<Refusal | null> {
  const status = await phoneStatus(userId);
  if (!status || status.phone.trim() === "") return refuse("PHONE_NEEDED");
  if (status.checks && !status.verified) return refuse("PHONE_UNVERIFIED");
  return null;
}

export type CheckResult = { ok: true; sent?: boolean } | { ok: false; error: string; code?: string };

/** With checks off: the number is simply saved, as it always was. */
export async function savePhone(userId: number, phone: string): Promise<CheckResult> {
  if (!phoneNumber(phone)) return { ok: false, error: "Please provide a valid phone number." };
  if (phoneChecksOn()) return { ok: false, error: "Numbers are checked here: ask for a code." };
  await getDb().prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone.trim(), userId);
  return { ok: true };
}

/** Send a code to this number, to prove the account holds it. */
export async function sendPhoneCode(userId: number, phone: string, locale: Locale = "en"): Promise<CheckResult> {
  const db = getDb();
  if (!phoneChecksOn()) return savePhone(userId, phone);
  const number = phoneNumber(phone);
  if (!number) return { ok: false, error: "Please provide a valid phone number." };
  await db.prepare("DELETE FROM phone_codes WHERE created_at < datetime('now', '-1 day')").run();
  const { mine } = (await db
    .prepare("SELECT COUNT(*)::int AS mine FROM phone_codes WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(userId)) as { mine: number };
  if (mine >= SENDS_PER_HOUR) return { ok: false, error: "That is a few codes already. Try again in an hour.", code: "PHONE_CODE_LIMIT" };
  const { toNumber } = (await db
    .prepare("SELECT COUNT(*)::int AS \"toNumber\" FROM phone_codes WHERE number = ?")
    .get(number)) as { toNumber: number };
  if (toNumber >= SENDS_PER_NUMBER_PER_DAY)
    return { ok: false, error: "That number has been sent enough codes for today. Try again tomorrow.", code: "PHONE_CODE_LIMIT" };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  try {
    await deliver(number, code, locale);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The code could not be sent." };
  }
  await db
    .prepare(
      `INSERT INTO phone_codes (user_id, phone, number, code_hash, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+${CODE_MINUTES} minutes'))`
    )
    .run(userId, phone.trim(), number, keyedHash("phone-code", `${userId}:${number}:${code}`));
  return { ok: true, sent: true };
}

/**
 * The code, as received. Right, and the number is the account's, checked;
 * any other account that had checked the same number loses it, since only
 * one of them can be holding the phone now. Wrong five times, and a new code
 * has to be asked for.
 */
export async function confirmPhoneCode(userId: number, code: string): Promise<CheckResult> {
  const db = getDb();
  const pending = (await db
    .prepare(
      `SELECT id, phone, number, code_hash, attempts FROM phone_codes
        WHERE user_id = ? AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`
    )
    .get(userId)) as { id: number; phone: string; number: string; code_hash: string; attempts: number } | undefined;
  if (!pending) return { ok: false, error: "That code has run out. Ask for a new one.", code: "PHONE_CODE_EXPIRED" };
  if (pending.attempts >= MAX_TRIES) return { ok: false, error: "Too many wrong tries. Ask for a new code.", code: "PHONE_CODE_EXPIRED" };
  const given = code.replace(/\D/g, "");
  const expected = Buffer.from(pending.code_hash, "hex");
  const actual = Buffer.from(keyedHash("phone-code", `${userId}:${pending.number}:${given}`), "hex");
  if (given.length !== 6 || !crypto.timingSafeEqual(expected, actual)) {
    await db.prepare("UPDATE phone_codes SET attempts = attempts + 1 WHERE id = ?").run(pending.id);
    return { ok: false, error: "That is not the code. Check it and try again.", code: "PHONE_CODE_WRONG" };
  }
  await db.transaction(async () => {
    await db.prepare("UPDATE users SET verified_phone = NULL, phone_verified_at = NULL WHERE verified_phone = ? AND id <> ?").run(pending.number, userId);
    await db
      .prepare("UPDATE users SET phone = ?, verified_phone = ?, phone_verified_at = datetime('now') WHERE id = ?")
      .run(pending.phone, pending.number, userId);
    await db.prepare("DELETE FROM phone_codes WHERE user_id = ?").run(userId);
  })();
  return { ok: true };
}

/**
 * The code, on WhatsApp, through the "authentication" template Meta keeps
 * for exactly this (WHATSAPP_CODE_TEMPLATE, default `mysenam_login_code`):
 * the code in the body, and again on its copy-code button.
 */
async function deliver(number: string, code: string, locale: Locale): Promise<void> {
  if (process.env.MYSENAM_SEND === "log") {
    console.info(`[phone code] → +${number}: ${code} (${siteName()})`);
    return;
  }
  const config = whatsappConfig();
  if (!config) throw new Error("WhatsApp is not set up here, so no code can be sent.");
  const res = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: number,
      type: "template",
      template: {
        name: process.env.WHATSAPP_CODE_TEMPLATE || "mysenam_login_code",
        language: { code: locale === "ms" ? "ms" : "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`WhatsApp did not take the code (${res.status})${detail?.error?.message ? `: ${detail.error.message}` : ""}.`);
  }
}
