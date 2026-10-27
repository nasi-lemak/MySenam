import crypto from "crypto";
import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import type { Locale } from "./i18n";
import { keyedHash } from "./secrets";
import { siteName } from "./site";
import { sendSms, smsConfig, smsText, toWhatsAppNumber, whatsappConfig } from "./transports";
import { chatNumber } from "./outbox";
import { tellOwners } from "./owner-alerts";
import type { Refusal } from "./types";

/**
 * A customer's phone number, checked.
 *
 * Nothing else here can tell a number somebody holds from one they typed:
 * the venue rings it, confirmations go to it, limits and blocks are kept by
 * it, and league box-mates are given it. So an account proves its number
 * once, and after that it counts as checked until the number changes. Two
 * ways, as the customer prefers:
 *
 * - **Via WhatsApp** (recommended): the customer sends us a short message
 *   from their own WhatsApp, a token in it, and the message arriving from
 *   that number is the proof. Nothing is sent to them, so it costs nothing,
 *   and it cannot be used to make us message strangers. Needs the platform's
 *   number and its webhook (WHATSAPP_CHAT_NUMBER, WHATSAPP_APP_SECRET).
 * - **Via SMS**: a six-digit code by text (lib/transports.ts, SMS_*). Where
 *   there is no SMS gateway but WhatsApp sending is set up, the code goes on
 *   WhatsApp instead, as an authentication template.
 *
 * Codes sent cost money, so the whole site sends at most
 * MYSENAM_PHONE_CODES_PER_DAY (300) a day; the owner is told when that is
 * reached, and WhatsApp verification carries on.
 *
 * On when either way is available (or MYSENAM_PHONE_CHECK=on; MYSENAM_SEND=log
 * then writes codes to the server log). Without one there is nothing to check
 * with, and a number is taken as given, as before. MYSENAM_PHONE_CHECK=off
 * turns it off regardless.
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

/** Codes the whole site may send in a day, by SMS or WhatsApp. */
export function codesPerDay(): number {
  const n = Number(process.env.MYSENAM_PHONE_CODES_PER_DAY ?? 300);
  return Number.isInteger(n) && n >= 0 ? n : 300;
}

/** The ways this install can check a number. */
export interface PhoneMethods {
  /** The customer sends us a message from their WhatsApp. */
  whatsapp: boolean;
  /** A code is sent to them: by SMS, or by WhatsApp where there is no SMS. */
  code: boolean;
  /** How the code goes. */
  codeBy: "sms" | "whatsapp";
}

export function phoneMethods(): PhoneMethods {
  const log = process.env.MYSENAM_SEND === "log";
  const sms = smsConfig() !== null;
  return {
    whatsapp: chatNumber() !== null && !!process.env.WHATSAPP_APP_SECRET,
    code: sms || whatsappConfig() !== null || log,
    codeBy: sms || (log && whatsappConfig() === null) ? "sms" : "whatsapp",
  };
}

export function phoneChecksOn(): boolean {
  const flag = process.env.MYSENAM_PHONE_CHECK;
  if (flag === "off") return false;
  if (flag === "on") return true;
  const m = phoneMethods();
  return m.whatsapp || smsConfig() !== null || whatsappConfig() !== null;
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
  /** The ways it can, for the page to offer. */
  methods?: PhoneMethods;
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
    methods: phoneMethods(),
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
  // A ceiling on what the whole site spends on codes in a day, whoever asks.
  const { today } = (await db
    .prepare("SELECT COUNT(*)::int AS today FROM phone_codes WHERE method = 'code' AND created_at > datetime('now', '-1 day')")
    .get()) as { today: number };
  if (today >= codesPerDay()) {
    // Told once, the first time today a code is refused.
    const told = await db.prepare("SELECT 1 FROM phone_codes WHERE method = 'refused' AND created_at > datetime('now', '-1 day')").get();
    if (!told)
      await tellOwners(
        "Phone codes paused for today",
        `${codesPerDay()} verification codes have been sent in the last day, the most MYSENAM_PHONE_CODES_PER_DAY allows. No more go out until the count falls; customers can still verify via WhatsApp. If this is real growth, raise the limit; if not, somebody may be asking for codes on purpose.`
      );
    await db
      .prepare(`INSERT INTO phone_codes (user_id, phone, number, code_hash, expires_at, method) VALUES (?, ?, ?, '', datetime('now'), 'refused')`)
      .run(userId, phone.trim(), number);
    return {
      ok: false,
      error: "Codes are paused for now. Please verify via WhatsApp instead, or try again later.",
      code: "PHONE_CODES_PAUSED",
    };
  }

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
        WHERE user_id = ? AND method = 'code' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`
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
  await markChecked(userId, pending.phone, pending.number);
  return { ok: true };
}

/** The number is the account's, checked; any other account that had it loses it. */
async function markChecked(userId: number, phone: string, number: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    await db.prepare("UPDATE users SET verified_phone = NULL, phone_verified_at = NULL WHERE verified_phone = ? AND id <> ?").run(number, userId);
    await db
      .prepare("UPDATE users SET phone = ?, verified_phone = ?, phone_verified_at = datetime('now') WHERE id = ?")
      .run(phone, number, userId);
    await db.prepare("DELETE FROM phone_codes WHERE user_id = ? AND method <> 'refused'").run(userId);
  })();
}

// ------------------------------------------------------------ via WhatsApp

/** Minutes the customer has to send the message. */
export const WHATSAPP_MINUTES = 15;
const TOKEN = /\bV-([A-Z2-9]{6})\b/i;

/**
 * Start a check the other way round: the customer sends us a message, from
 * the number they are proving, with this token in it — the link opens
 * WhatsApp with the message ready, and they press send.
 */
export async function startWhatsappCheck(
  userId: number,
  phone: string,
  locale: Locale = "en"
): Promise<{ ok: true; token: string; link: string; text: string } | { ok: false; error: string; code?: string }> {
  const methods = phoneMethods();
  if (!methods.whatsapp) return { ok: false, error: "Verifying via WhatsApp is not set up here." };
  const number = phoneNumber(phone);
  if (!number) return { ok: false, error: "Please provide a valid phone number." };
  const db = getDb();
  await db.prepare("DELETE FROM phone_codes WHERE created_at < datetime('now', '-1 day')").run();
  const { mine } = (await db
    .prepare("SELECT COUNT(*)::int AS mine FROM phone_codes WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(userId)) as { mine: number };
  if (mine >= SENDS_PER_HOUR * 2) return { ok: false, error: "That is a few tries already. Try again in an hour.", code: "PHONE_CODE_LIMIT" };
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const token = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
  await db
    .prepare(
      `INSERT INTO phone_codes (user_id, phone, number, code_hash, expires_at, method, token)
       VALUES (?, ?, ?, '', datetime('now', '+${WHATSAPP_MINUTES} minutes'), 'whatsapp', ?)`
    )
    .run(userId, phone.trim(), number, token);
  const t = translator(locale);
  const text = t("phone.waMessage", { token: `V-${token}` });
  return { ok: true, token: `V-${token}`, text, link: `https://wa.me/${chatNumber()}?text=${encodeURIComponent(text)}` };
}

/**
 * A WhatsApp message to the platform's number: if it carries a token we
 * handed out and comes from the number it was for, that number is checked.
 * From any other number, it proves nothing and does nothing.
 */
export async function verifyFromWhatsapp(from: string, text: string): Promise<boolean> {
  const token = text.match(TOKEN)?.[1]?.toUpperCase();
  if (!token) return false;
  const sender = phoneNumber(from);
  if (!sender) return false;
  const row = (await getDb()
    .prepare(
      `SELECT user_id, phone, number FROM phone_codes
        WHERE method = 'whatsapp' AND token = ? AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`
    )
    .get(token)) as { user_id: number; phone: string; number: string } | undefined;
  if (!row || row.number !== sender) return false;
  await markChecked(row.user_id, row.phone, row.number);
  return true;
}

/**
 * A code a venue's staff send to a number on record for somebody without an
 * account (lib/contact-guardians.ts): the same delivery and the same site-wide
 * daily ceiling as a customer's own code, with its own words by SMS (`text`,
 * which carries the code and the venue, nothing else). How it went, or why
 * it could not.
 */
export async function sendCodeToNumber(number: string, code: string, text: string, locale: Locale = "en"): Promise<{ ok: true; channel: "sms" | "whatsapp" | "log" } | { ok: false; error: string; code: string }> {
  if (!phoneMethods().code) return { ok: false, error: "No SMS or WhatsApp is set up here to send a code with.", code: "GW5_NO_PHONE_CODES" };
  const db = getDb();
  const { today } = (await db
    .prepare(
      `SELECT ((SELECT COUNT(*) FROM phone_codes WHERE method = 'code' AND created_at > datetime('now', '-1 day'))
             + (SELECT COUNT(*) FROM guardian_contact_codes WHERE created_at > now() - interval '1 day'))::int AS today`
    )
    .get()) as { today: number };
  if (today >= codesPerDay()) return { ok: false, error: "Codes are paused for now. Please try again later.", code: "PHONE_CODES_PAUSED" };
  const channel = process.env.MYSENAM_SEND === "log" ? "log" : smsConfig() ? "sms" : "whatsapp";
  try {
    await deliver(number, code, locale, text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The code could not be sent.", code: "GW5_CODE_NOT_SENT" };
  }
  return { ok: true, channel };
}

/**
 * The code, on WhatsApp, through the "authentication" template Meta keeps
 * for exactly this (WHATSAPP_CODE_TEMPLATE, default `mysenam_login_code`):
 * the code in the body, and again on its copy-code button.
 */
async function deliver(number: string, code: string, locale: Locale, text?: string): Promise<void> {
  if (process.env.MYSENAM_SEND === "log") {
    console.info(`[phone code] → +${number}: ${code} (${siteName()})`);
    return;
  }
  const sms = smsConfig();
  if (sms) return sendSms(sms, number, smsText(text ?? translator(locale)("phone.smsText", { site: siteName(), code })));
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
        language: { code: { en: "en", ms: "ms", zh: "zh_CN", ta: "ta" }[locale] ?? "en" },
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
