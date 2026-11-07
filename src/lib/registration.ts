import crypto from "crypto";
import { getDb } from "./db";
import { hashPassword, type User } from "./auth";
import { keyedHash } from "./secrets";
import { baseUrl, drainOutbox, enqueue, type OutboxMessage } from "./outbox";
import { siteName } from "./site";
import { errorText, isLocale, translator, type ErrorCode, type Locale } from "./i18n";
import { linkIn } from "./link-locale";
import { googleConfig } from "./oauth";
import { AUTH_MAIL_COOLDOWN_SECONDS, MIN_PASSWORD } from "./password-reset";
import type { Refusal } from "./types";
import { REGISTRATION_MINUTES } from "./registration-shared";
import { nameRefusal } from "./contact-fields";

/**
 * Signing up by an emailed link, without saying whether an address already
 * has an account (the owner's decision of 28 October 2026;
 * docs/architecture/authentication.md#signing-up).
 *
 * **Start.** The form takes the email address and nothing else, and always
 * answers the same: "check your email", the same status, body and headers,
 * whatever the address. The reply waits only on writing the request down
 * (`registration_requests`); finding out whether an account holds the
 * address, and what to send, happen after it (`processRegistrationRequests`),
 * as a forgotten password's request does (lib/password-reset.ts), so how long
 * it takes says nothing either. Nothing else is asked first: a name, number
 * or password kept for an address nobody has proved would be data about
 * somebody who may never have asked, and a password set before the address
 * is proved is the takeover that Google sign-in has to undo (lib/oauth.ts).
 *
 * **The email.** An address no account holds is sent a link to finish
 * making the account. One that has an account is sent a notice saying so,
 * with how to sign in, how to set a new password, and, where the account
 * uses Google, to continue with Google: no link that creates or changes
 * anything. Both go through the outbox in the visitor's language, held like
 * a password reset's (no venue's, their text not kept once sent, never
 * readdressed, not sent once the link would have run out). An address is sent
 * at most REGISTRATION_EMAILS_PER_HOUR an hour and REGISTRATION_EMAILS_PER_DAY
 * a day, of both kinds together; past that, requests are answered the same
 * and nothing is sent.
 *
 * **The link** is 24 random bytes, kept only as a keyed hash. It works once,
 * for REGISTRATION_MINUTES, and only the newest for an address works. Opening
 * it shows the address and asks for the name, phone number and password the
 * account needs; using it and making the account are one transaction, and the
 * unique address on `users` is the backstop when two links, or a link and
 * Google, race for one address: one account is made, and every other link is
 * refused in the one neutral answer, which says to sign in.
 */

export { REGISTRATION_MINUTES };
/** Emails a sign-up may send one address, links and notices together. */
export const REGISTRATION_EMAILS_PER_HOUR = 3;
export const REGISTRATION_EMAILS_PER_DAY = 5;

/** The shape of an email address: nothing about whether an account holds it. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^\+?[0-9 -]{7,20}$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

const hashOf = (token: string) => keyedHash("registration", token);

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

/** Every link that cannot be used, for whatever reason, is refused in these words. */
export const registrationInvalid = () => refuse("REGISTRATION_INVALID");

/**
 * Ask to sign up with this address. Always "ok", after the one statement
 * that writes the request down, whatever the address: the account is looked
 * for, and the email made and queued, after the reply.
 */
export async function requestRegistration(email: string, locale: Locale = "en"): Promise<{ ok: true }> {
  await getDb()
    .prepare("INSERT INTO registration_requests (email, locale) VALUES (?, ?)")
    .run(email.trim().slice(0, 320), locale);
  workThroughSoon();
  return { ok: true };
}

/** The requests this process is working through, one run after another. */
let working: Promise<void> = Promise.resolve();

/** Work through the queued requests once the reply has gone; whatever this misses, the scheduler picks up (lib/notify.ts, tickOutbox). */
function workThroughSoon(): void {
  working = working
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(() => processRegistrationRequests())
    .then(() => drainOutbox())
    .then(
      () => undefined,
      () => undefined
    );
}

/** Wait for the requests this process has started working through. */
export async function settleRegistrationRequests(): Promise<void> {
  await working;
}

/**
 * Work through queued requests: each is taken once (two servers at once take
 * different ones) and answered by email, within the address's caps. A request
 * older than a link's life is dropped unsent. Rows older than a day, kept only
 * to count the caps, go. Answers how many emails were queued.
 */
export async function processRegistrationRequests(limit = 25): Promise<number> {
  const db = getDb();
  await db.prepare("DELETE FROM registration_links WHERE created_at < datetime('now', '-1 day')").run();
  const taken = (await db
    .prepare(
      `DELETE FROM registration_requests WHERE id IN (
         SELECT id FROM registration_requests ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING id, email, locale, created_at >= datetime('now', '-${REGISTRATION_MINUTES} minutes') AS fresh`
    )
    .all(limit)) as { id: number; email: string; locale: string; fresh: boolean }[];
  let queued = 0;
  for (const r of taken.sort((a, b) => a.id - b.id))
    if (r.fresh && EMAIL_SHAPE.test(r.email) && (await answerRequest(r.email, isLocale(r.locale) ? r.locale : "en"))) queued++;
  return queued;
}

/** A new link's secret: 24 random bytes. */
const newToken = () => crypto.randomBytes(24).toString("base64url");

/**
 * The email one request earns, if the address's caps allow: a link where no
 * account holds the address (replacing any still open), a notice where one
 * does. The link, its row and its email are written together.
 */
async function answerRequest(email: string, locale: Locale): Promise<boolean> {
  const db = getDb();
  const token = newToken();
  return db.transaction(async (): Promise<boolean> => {
    // Requests for one address take turns, so that ones that arrive together make one email (ADR 0073).
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`auth-mail:register:${email.toLowerCase()}`);
    const sent = (await db
      .prepare(
        `SELECT COUNT(*)::int AS day, (COUNT(*) FILTER (WHERE created_at > datetime('now', '-1 hour')))::int AS hour
           FROM registration_links WHERE email = ? AND created_at > datetime('now', '-1 day')`
      )
      .get(email)) as { day: number; hour: number };
    if (sent.hour >= REGISTRATION_EMAILS_PER_HOUR || sent.day >= REGISTRATION_EMAILS_PER_DAY) return false;
    // A moment after the last one, or while the last one has not gone yet (the provider is down, or it waits its turn), another is
    // not made: that one is sent as soon as it can be, and clicking again makes no second link and no second email.
    const open = (await db
      .prepare(
        `SELECT (l.created_at > datetime('now', '-${AUTH_MAIL_COOLDOWN_SECONDS} seconds')) AS cooling,
                (l.expires_at > datetime('now') AND l.used_at IS NULL AND l.replaced_at IS NULL AND COALESCE(m.status IN ('queued', 'failed'), false)) AS waiting
           FROM registration_links l LEFT JOIN messages m ON m.id = l.message_id
          WHERE l.email = ? AND l.created_at > datetime('now', '-1 day')`
      )
      .all(email)) as { cooling: boolean; waiting: boolean }[];
    if (open.some((r) => r.cooling || r.waiting)) return false;
    const account = (await db
      .prepare(
        `SELECT u.id, u.name, u.email, u.password_hash <> '' AS has_password,
                EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = 'google') AS google
           FROM users u WHERE u.email = ?`
      )
      .get(email)) as { id: number; name: string; email: string; has_password: boolean; google: boolean } | undefined;
    const t = translator(locale);
    const site = siteName();
    if (account) {
      const row = (await db
        .prepare(`INSERT INTO registration_links (email, kind, locale, expires_at) VALUES (?, 'notice', ?, datetime('now', '+${REGISTRATION_MINUTES} minutes')) RETURNING id`)
        .get(account.email, locale)) as { id: number };
      const parts = [
        t("su7.mail.existing.b", { name: account.name.split(/\s+/)[0], site }),
        t("su7.mail.existing.signIn", { link: linkIn(`${baseUrl()}/login`, locale) }),
        // Only where the button is there to press.
        account.google && googleConfig() ? t("su7.mail.existing.google") : null,
        t(account.has_password ? "su7.mail.existing.reset" : "su7.mail.existing.setPassword", { link: linkIn(`${baseUrl()}/forgot-password`, locale) }),
        t("su7.mail.existing.notYou"),
      ];
      const queued = await send(account.email, locale, t("su7.mail.existing.s", { site }), parts.filter((p): p is string => Boolean(p)).join("\n\n"));
      await db.prepare("UPDATE registration_links SET message_id = ? WHERE id = ?").run(queued.id, row.id);
    } else {
      await db
        .prepare("UPDATE registration_links SET replaced_at = datetime('now') WHERE email = ? AND kind = 'link' AND used_at IS NULL AND replaced_at IS NULL")
        .run(email);
      const row = (await db
        .prepare(
          `INSERT INTO registration_links (email, kind, token_hash, locale, expires_at) VALUES (?, 'link', ?, ?, datetime('now', '+${REGISTRATION_MINUTES} minutes')) RETURNING id`
        )
        .get(email, hashOf(token), locale)) as { id: number };
      const link = linkIn(`${baseUrl()}/register?token=${token}`, locale);
      const queued = await send(email, locale, t("su7.mail.new.s", { site }), t("su7.mail.new.b", { site, link, minutes: REGISTRATION_MINUTES }));
      // Written off for the security-mail allowance: nobody has this link, so it is void.
      if (queued.status === "abandoned") await db.prepare("UPDATE registration_links SET replaced_at = datetime('now') WHERE id = ?").run(row.id);
      else await db.prepare("UPDATE registration_links SET message_id = ? WHERE id = ?").run(queued.id, row.id);
    }
    return true;
  })();
}

/** Queued like a password reset's, as security mail (`auth_email`, ADR 0073): no venue's, its text not kept once sent, not sent once it is out of date. */
async function send(to: string, locale: Locale, subject: string, text: string): Promise<OutboxMessage> {
  return enqueue({
    venueId: null,
    kind: "auth_email",
    channel: "email",
    recipient: to,
    locale,
    subject: "msg.programmeSubject",
    body: "msg.programmeBody",
    vars: { subject, text },
    expiresMinutes: REGISTRATION_MINUTES,
  });
}

/** The address a link is for, while it can still be used; else the one neutral refusal. */
export async function registrationLink(token: string): Promise<{ ok: true; email: string } | Refusal> {
  if (!TOKEN_SHAPE.test(token)) return registrationInvalid();
  const row = (await getDb()
    .prepare(
      `SELECT l.email::text AS email FROM registration_links l
        WHERE l.token_hash = ? AND l.kind = 'link' AND l.used_at IS NULL AND l.replaced_at IS NULL AND l.expires_at > datetime('now')
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = l.email)`
    )
    .get(hashOf(token))) as { email: string } | undefined;
  return row ? { ok: true, email: row.email } : registrationInvalid();
}

export type CompleteResult = { ok: true; user: User } | Refusal;

/**
 * Finish signing up with an emailed link: the link is used and the account
 * made in one transaction. A link used, replaced, run out, or for an address
 * that has an account by now (another link, Google) makes nothing and gets the
 * one neutral refusal. Whoever holds the link was sent it at the address, so
 * telling them to sign in says nothing they could not find out.
 */
export async function completeRegistration(
  token: string,
  input: { name: string; phone: string; password: string }
): Promise<CompleteResult> {
  const badName = nameRefusal(input.name);
  if (badName) return badName;
  if (!PHONE_SHAPE.test(input.phone.trim())) return { ok: false, error: "Please provide a valid phone number." };
  if (input.password.length < MIN_PASSWORD || input.password.length > 200) return refuse("PASSWORD_WEAK", { n: MIN_PASSWORD });
  if (!TOKEN_SHAPE.test(token)) return registrationInvalid();
  // Hashed before the transaction, which may run again, and so its row lock is held only for database work.
  const passwordHash = hashPassword(input.password);
  const db = getDb();
  return db.transaction(async (): Promise<CompleteResult> => {
    const link = (await db
      .prepare(
        `UPDATE registration_links SET used_at = datetime('now')
          WHERE token_hash = ? AND kind = 'link' AND used_at IS NULL AND replaced_at IS NULL AND expires_at > datetime('now')
          RETURNING id, email::text AS email, locale`
      )
      .get(hashOf(token))) as { id: number; email: string; locale: string } | undefined;
    if (!link) return registrationInvalid();
    const user = (await db
      .prepare(
        `INSERT INTO users (name, email, phone, password_hash, locale, email_confirmed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (email) DO NOTHING RETURNING id, name, email::text AS email, phone`
      )
      .get(input.name.trim(), link.email, input.phone.trim(), passwordHash, isLocale(link.locale) ? link.locale : null)) as User | undefined;
    if (!user) {
      // The address has an account already: this link made nothing, and is void.
      await db.prepare("UPDATE registration_links SET used_at = NULL, replaced_at = datetime('now') WHERE id = ?").run(link.id);
      return registrationInvalid();
    }
    return { ok: true, user };
  })();
}
