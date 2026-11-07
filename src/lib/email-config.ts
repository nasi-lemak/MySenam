import crypto from "crypto";
import { sesCall, sesConfigFromEnv, sesHost } from "./ses.ts";

/**
 * Is email set up, and can it be trusted with a sign-up or a password reset? One validator, one structured answer (ADR 0073).
 *
 * Before this, the outbox decided: with nothing set up a message simply queued, and the pages still said "check your email". Now
 * the install's email configuration is read once, here, into a state:
 *
 *   not_configured         no provider at all
 *   invalid                a provider half set up, or a setting that cannot be right (a region, an SMTP address, a sender)
 *   contradictory          Amazon SES and SMTP both set (the app would use SES and silently ignore SMTP)
 *   missing_sender         a provider, and no MAIL_FROM
 *   log_only               MYSENAM_SEND=log: every message, links included, is written to the server log and called sent
 *   configured_unverified  looks right; nobody has recorded a controlled delivery check
 *   delivery_verified      looks right, and the operator recorded a delivery check for this very provider and sender
 *
 * "Provider reachable" is not a state: it is an explicit, opt-in call (`checkProviderReachable`) that talks to the provider without
 * sending a message, never made by the tests or by a page load. "Delivery verified" is never inferred from credentials being
 * present: the operator runs `node scripts/verify-integrations.mjs email --send` to an address they control, confirms in its inbox
 * that the message arrived, and sets `MAIL_DELIVERY_VERIFIED` to the fingerprint the script prints. The fingerprint is of the
 * provider (SES region or SMTP host) and the sender address, so changing either returns the install to "unverified".
 *
 * On a **production marketplace** (NODE_ENV=production and MYSENAM_MARKETPLACE=on, as the staff two-factor default reads it), every
 * state that cannot deliver, `log_only` included, **blocks** public account email (sign-up and forgotten password): the request is
 * refused with a plain "temporarily unavailable, contact the venue" rather than answered "check your email" with nothing sent. The
 * only way past it is `MYSENAM_SYNTHETIC_DATA=on` with `MYSENAM_SEND=log`, for a staging or acceptance install holding synthetic data
 * and nobody's real account (AGENTS.md), which is flagged all the same. There is no other bypass.
 *
 * This file reads the environment and nothing else (no database), and imports `.ts` paths, so the verification script can load it.
 * Nothing it returns holds a secret: problems name the setting, never its value.
 */

/** The environment as read: process.env, or a set of settings given to it. */
export type Env = Record<string, string | undefined>;

export type EmailState = "not_configured" | "invalid" | "contradictory" | "missing_sender" | "log_only" | "configured_unverified" | "delivery_verified";

export interface EmailConfigState {
  state: EmailState;
  provider: "ses" | "smtp" | null;
  /** What is wrong, in plain English, naming settings and never their values. Empty for a configured state. */
  problems: string[];
  productionMarketplace: boolean;
  /** Public sign-up and forgotten-password requests are refused: a production marketplace whose email cannot deliver. */
  blocksAccountEmail: boolean;
  /** Written to the log by declared synthetic data, honoured and flagged. */
  syntheticLog: boolean;
  /** Names the provider and sender, for `MAIL_DELIVERY_VERIFIED`; null when the configuration is not usable. */
  fingerprint: string | null;
}

const SES_SETTINGS = ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION"] as const;
const ON = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";

/** The bare address of a sender: `Arena Bookings <bookings@arena.my>` or `bookings@arena.my`. Null when there is none. */
export function senderAddress(from: string | undefined): string | null {
  const text = (from ?? "").trim();
  const angled = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(text)?.[1];
  const address = angled ?? (/^[^\s<>@]+@[^\s<>@]+$/.test(text) ? text : null);
  return address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

function smtpTarget(url: string): string | null {
  if (!/^smtps?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.hostname ? `${u.hostname}:${u.port || (u.protocol.toLowerCase() === "smtps:" ? "465" : "587")}` : null;
  } catch {
    return null;
  }
}

function fingerprintOf(provider: "ses" | "smtp", target: string, address: string): string {
  return crypto.createHash("sha256").update(`${provider}|${target.toLowerCase()}|${address.toLowerCase()}`).digest("hex").slice(0, 16);
}

/** What the install's email configuration is, from its environment. */
export function emailConfigState(env: Env = process.env): EmailConfigState {
  const productionMarketplace = env.NODE_ENV === "production" && env.MYSENAM_MARKETPLACE === "on";
  const synthetic = ON(env.MYSENAM_SYNTHETIC_DATA);
  const sesSet = SES_SETTINGS.filter((n) => env[n]?.trim());
  const sesFull = sesSet.length === SES_SETTINGS.length;
  const smtpUrl = env.SMTP_URL?.trim() ?? "";
  const from = env.MAIL_FROM?.trim() ?? "";
  const address = senderAddress(from);

  const invalid: string[] = [];
  let contradictory = false;
  if (sesSet.length > 0 && !sesFull)
    invalid.push(`Amazon SES is half set up: ${SES_SETTINGS.filter((n) => !sesSet.includes(n)).join(", ")} ${SES_SETTINGS.length - sesSet.length === 1 ? "is" : "are"} missing.`);
  if (sesFull)
    try {
      sesHost(env.SES_REGION!.trim());
    } catch {
      invalid.push("SES_REGION is not an AWS region name (for example ap-southeast-1).");
    }
  if (smtpUrl && !smtpTarget(smtpUrl)) invalid.push("SMTP_URL is not an smtp:// or smtps:// address with a host.");
  if (sesFull && smtpUrl) contradictory = true;
  if (from && !address) invalid.push("MAIL_FROM has no valid email address in it (use bookings@example.my or Name <bookings@example.my>).");

  const providerSet = sesSet.length > 0 || smtpUrl !== "";
  const provider: "ses" | "smtp" | null = sesFull ? "ses" : smtpUrl && smtpTarget(smtpUrl) ? "smtp" : null;
  const problems = [...invalid];
  let state: EmailState;
  if (contradictory) problems.push("Both Amazon SES (SES_*) and SMTP (SMTP_URL) are set. The app uses SES and ignores SMTP; set only the one in use so nobody has to guess which it is.");
  if (!providerSet) problems.push("No email provider is set up: set SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_REGION and MAIL_FROM (Amazon SES), or SMTP_URL and MAIL_FROM (SMTP).");
  else if (!from) problems.push("MAIL_FROM is not set: there is no sender address for the email.");

  if (invalid.length > 0) state = "invalid";
  else if (contradictory) state = "contradictory";
  else if (!providerSet) state = "not_configured";
  else if (!from) state = "missing_sender";
  else state = "configured_unverified";

  let fingerprint: string | null = null;
  if (state === "configured_unverified" && provider && address) {
    fingerprint = fingerprintOf(provider, provider === "ses" ? env.SES_REGION!.trim() : smtpTarget(smtpUrl)!, address);
    if (env.MAIL_DELIVERY_VERIFIED?.trim().toLowerCase() === fingerprint) state = "delivery_verified";
  }

  // MYSENAM_SEND=log is what the outbox does whatever else is set (lib/outbox.ts `transport`): the log is the transport.
  let syntheticLog = false;
  if (env.MYSENAM_SEND === "log") {
    problems.unshift("MYSENAM_SEND=log writes every message, sign-up and password-reset links included, to the server log and marks it sent. Nothing is delivered to anybody.");
    state = "log_only";
    syntheticLog = productionMarketplace && synthetic;
  }

  const delivers = state === "configured_unverified" || state === "delivery_verified" || (state === "log_only" && syntheticLog);
  return {
    state,
    provider,
    problems: state === "configured_unverified" || state === "delivery_verified" ? [] : problems,
    productionMarketplace,
    blocksAccountEmail: productionMarketplace && !delivers,
    syntheticLog,
    fingerprint,
  };
}

/** Whether public account email (a sign-up request, a forgotten-password request) must be refused on this install right now. */
export function accountEmailBlocked(env: Env = process.env): boolean {
  return emailConfigState(env).blocksAccountEmail;
}

// ------------------------------------------------------------ reachable (opt-in)

export interface ReachableResult {
  /** True: the provider answered and accepted the credentials. False: it did not, or refused them. Null: nothing to ask. */
  reachable: boolean | null;
  /** What was found, with no credential in it. */
  detail: string;
}

/** Nothing secret in what is reported. */
function scrubbed(env: Env, text: string): string {
  const secrets = [env.SES_ACCESS_KEY_ID, env.SES_SECRET_ACCESS_KEY, env.SES_SESSION_TOKEN, env.SMTP_URL]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length >= 4);
  try {
    const u = new URL(env.SMTP_URL ?? "");
    if (u.password) secrets.push(decodeURIComponent(u.password), u.password);
    if (u.username) secrets.push(decodeURIComponent(u.username), u.username);
  } catch {
    // not a URL
  }
  return secrets.reduce((t, s) => t.split(s).join("***"), text);
}

const KEY_REFUSED = /UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|InvalidClientTokenId|ExpiredToken|IncompleteSignature|MissingAuthenticationToken/i;

/**
 * Ask the provider whether it answers and accepts the credentials, without sending a message: Amazon SES's account call, or an SMTP
 * connection and sign-in. Only ever called on purpose (the owner's "check email" action, the verification script): never at
 * start-up, on a page load or by the tests. `Reachable` is not "delivers": a person confirms the inbox (`delivery_verified`).
 */
export async function checkProviderReachable(env: Env = process.env): Promise<ReachableResult> {
  const config = emailConfigState(env);
  if (config.provider === null || config.state === "invalid" || config.state === "contradictory" || config.state === "missing_sender")
    return { reachable: null, detail: "There is no usable email configuration to check." };
  try {
    if (config.provider === "ses") {
      const ses = sesConfigFromEnv(env as NodeJS.ProcessEnv);
      if (!ses) return { reachable: null, detail: "There is no usable email configuration to check." };
      const reply = await sesCall(ses, { method: "GET", path: "/v2/email/account" });
      if (reply.status === 200) return { reachable: true, detail: "Amazon SES answered and accepted the key. This does not prove a message is delivered." };
      if (KEY_REFUSED.test(reply.type ?? "")) return { reachable: false, detail: `Amazon SES refused the key (${reply.status} ${reply.type}).` };
      if (reply.status === 403)
        return { reachable: true, detail: "Amazon SES answered; the key is not allowed to read account details (ses:GetAccount), which does not stop it sending." };
      return { reachable: false, detail: scrubbed(env, `Amazon SES answered ${reply.status}${reply.type ? ` ${reply.type}` : ""}.`) };
    }
    const nodemailer = (await import("nodemailer")).default;
    // Bounded: the URL's own query sets nodemailer's timeouts.
    const url = new URL(env.SMTP_URL!.trim());
    for (const name of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) url.searchParams.set(name, "10000");
    await nodemailer.createTransport(url.toString()).verify();
    return { reachable: true, detail: "The SMTP server answered and accepted the sign-in. This does not prove a message is delivered." };
  } catch (err) {
    return { reachable: false, detail: scrubbed(env, err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/** The line that tells an operator how to record a delivery check, for the verification script's output. */
export function deliveryRecordInstruction(env: Env = process.env): string | null {
  const probe = emailConfigState({ ...env, MAIL_DELIVERY_VERIFIED: "", MYSENAM_SEND: "" });
  return probe.fingerprint
    ? `Once a person has confirmed in the inbox that the message arrived (not in spam) with SPF, DKIM and DMARC passing, record it: set MAIL_DELIVERY_VERIFIED=${probe.fingerprint} on the install and restart. It names this provider and sender; changing either needs a new check.`
    : null;
}
