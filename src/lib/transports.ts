import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { DICTIONARIES, Locale, Phrase } from "./i18n";
import type { MessageKind, OutboxMessage, Transport } from "./outbox";
import { region } from "./region";
import { internationalNumber } from "./phone";
import { sendRawEmail, sesConfigFromEnv } from "./ses";
import type { SesConfig } from "./ses";

/**
 * The real ways a message leaves the machine: WhatsApp and email.
 *
 * Both are switched on by configuration alone, and neither is required. A venue
 * that has only an email account (SMTP, or Amazon SES over HTTPS) still gets its confirmations out by email; one
 * with only WhatsApp reaches everybody, because everybody books with a phone
 * number.
 */

// ------------------------------------------------------------------ WhatsApp

/**
 * The phrase each kind of message is written from.
 *
 * WhatsApp will only let a business start a conversation with a template Meta
 * has approved, so the finished text in the outbox cannot simply be posted.
 * Instead each kind of message is a template, made from the same phrase the
 * email is, and what fills it is sent as its parameters. One wording, two
 * channels: change a phrase and its template in docs/integrations/whatsapp-templates.md, which is
 * what gets resubmitted to Meta, fails a test until it is brought up to date.
 */
export const TEMPLATE_PHRASES: Partial<Record<MessageKind, Phrase>> = {
  booking_confirmed: "msg.confirmed",
  booking_series_confirmed: "msg.series",
  booking_cancelled: "msg.cancelled",
  waitlist_offer: "msg.offer",
  class_enrolled: "msg.enrolled",
  booking_cancelled_by_venue: "msg.venueCancelled",
  booking_moved: "msg.moved",
  booking_rescheduled: "msg.rescheduled",
  booking_reminder: "msg.reminder",
  venue_new_booking: "msg.venueNewBooking",
  guardian_notice: "gw5.msg.notice",
  venue_booking_change: "p8c.msg.venueChange",
};

/** The language codes Meta files a template's translations under. */
const WHATSAPP_LANGUAGE: Record<Locale, string> = { en: "en", ms: "ms", zh: "zh_CN", ta: "ta" };

/** `{name}` placeholders in the order they first appear. */
export function placeholders(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(/\{(\w+)\}/g)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** A template as it is submitted to Meta: the phrase with `{{1}}`, `{{2}}`… */
export function templateText(kind: MessageKind, locale: Locale): {
  name: string;
  language: string;
  body: string;
  params: string[];
} {
  const key = TEMPLATE_PHRASES[kind];
  if (!key) throw new Error(`A ${kind.replace(/_/g, " ")} message goes by email only.`);
  const phrase = DICTIONARIES[locale][key];
  const params = placeholders(phrase);
  const body = phrase.replace(/\{(\w+)\}/g, (_, key: string) => `{{${params.indexOf(key) + 1}}}`);
  return { name: templateName(kind), language: WHATSAPP_LANGUAGE[locale], body, params };
}

export function templateName(kind: MessageKind): string {
  const prefix = (process.env.WHATSAPP_TEMPLATE_PREFIX || "mysenam").toLowerCase();
  return `${prefix}_${kind}`;
}

/** A number WhatsApp will accept: digits only, with the country code (lib/phone.ts). */
export function toWhatsAppNumber(phone: string): string {
  return internationalNumber(phone);
}

/**
 * A parameter as WhatsApp will take it: one line, never empty.
 *
 * Meta refuses a parameter with a newline, a tab, or more than four spaces in
 * a row, and refuses an empty one outright.
 */
export function templateParam(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\s*[\r\n\t]+\s*/g, " · ")
    .replace(/ {2,}/g, " ")
    .trim();
  return text === "" ? "-" : text;
}

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  apiVersion: string;
}

export function whatsappConfig(): WhatsAppConfig | null {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId, apiVersion: process.env.WHATSAPP_API_VERSION || "v23.0" };
}

export function whatsappTransport(config: WhatsAppConfig): Transport {
  return {
    name: "whatsapp",
    async send(message: OutboxMessage) {
      // A reply in a chat the customer opened goes as plain text, which is free;
      // anything else has to be one of Meta's approved templates.
      if (message.free) return await post(config, {
        to: toWhatsAppNumber(message.recipient),
        type: "text",
        text: { body: message.body, preview_url: false },
      });
      if (!message.params)
        throw new Error(
          "This message was written before WhatsApp templates were in use. Retry it to send it again."
        );
      const { name, language, params } = templateText(message.kind, message.locale);
      return await post(config, {
            to: toWhatsAppNumber(message.recipient),
            type: "template",
            template: {
              name,
              language: { code: language },
              components: [
                {
                  type: "body",
                  parameters: params.map((key) => ({
                    type: "text",
                    text: templateParam(message.params![key]),
                  })),
                },
              ],
            },
      });
    },
  };
}

/** One message to Meta's Cloud API; throws with Meta's reason when it is refused. */
async function post(config: WhatsAppConfig, message: Record<string, unknown>): Promise<{ providerId?: string }> {
  const res = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as {
      error?: { message?: string; error_data?: { details?: string } };
    } | null;
    const why = detail?.error?.error_data?.details || detail?.error?.message || res.statusText;
    throw new Error(`WhatsApp refused it (${res.status}): ${why}`);
  }
  // Meta's id for the message, which its delivery reports quote.
  const sent = (await res.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
  return { providerId: sent?.messages?.[0]?.id };
}

// --------------------------------------------------------------------- email

export type EmailConfig =
  | {
      /** Optional so that a config written before there were two ways (a bare `{ url, from }`) is still SMTP. */
      kind?: "smtp";
      /** smtp://user:pass@host:587 or smtps://user:pass@host:465 */
      url: string;
      from: string;
    }
  | SesConfig;

/**
 * Whether email is set up, and how: the one place that answers it.
 *
 * Amazon SES over HTTPS (SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_REGION, MAIL_FROM) wins when
 * both it and SMTP (SMTP_URL, MAIL_FROM) are set, because the cloud hosts that refuse SMTP are why
 * it exists. Neither set: null.
 */
export function emailConfig(): EmailConfig | null {
  const ses = sesConfigFromEnv();
  if (ses) return ses;
  const url = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM;
  if (!url || !from) return null;
  return { kind: "smtp", url, from };
}

let mailer: { url: string; transporter: Transporter } | null = null;

function transporterFor(url: string): Transporter {
  if (!mailer || mailer.url !== url) mailer = { url, transporter: nodemailer.createTransport(url) };
  return mailer.transporter;
}

export function unsubscribeHeaders(link: unknown): { headers?: Record<string, string> } {
  if (typeof link !== "string" || !/\/unsubscribe\/[\w-]+$/.test(link)) return {};
  const oneClick = link.replace(/\/unsubscribe\/([\w-]+)$/, "/api/unsubscribe/$1");
  return { headers: { "List-Unsubscribe": `<${oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}

/** The message as nodemailer is given it, the same whichever way it leaves. */
function mailFor(from: string, message: OutboxMessage) {
  return {
    from,
    to: message.recipient,
    subject: message.subject ?? undefined,
    text: message.body,
    // The booking as a calendar invite: in the customer's diary in a tap,
    // with its own reminder.
    ...(message.calendar ? { icalEvent: { filename: "booking.ics", method: "PUBLISH", content: message.calendar } } : {}),
    // A venue's news: the mail app's own unsubscribe button, one click (RFC 8058).
    ...(message.kind === "campaign" ? unsubscribeHeaders(message.params?.link) : {}),
  };
}

/** The finished message as the bytes of an email (MIME), without sending it anywhere. */
async function rawMessage(mail: ReturnType<typeof mailFor>): Promise<Buffer> {
  const info = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" }).sendMail(mail);
  return info.message as Buffer;
}

export function emailTransport(config: EmailConfig): Transport {
  return {
    name: "email",
    async send(message: OutboxMessage) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.recipient))
        throw new Error(`${message.recipient} is not an email address.`);
      const mail = mailFor(config.from, message);
      if (config.kind === "ses")
        return await sendRawEmail(config, { from: config.from, to: message.recipient, raw: await rawMessage(mail) });
      await transporterFor(config.url).sendMail(mail);
    },
  };
}

// ----------------------------------------------------------------------- SMS

/**
 * Text messages, for one thing only: the code that checks a customer's phone
 * number, for anybody who would rather not verify on WhatsApp.
 *
 * Twilio (SMS_TWILIO_ACCOUNT_SID, SMS_TWILIO_AUTH_TOKEN, SMS_FROM), or any
 * gateway that sends with one HTTP GET (SMS_HTTP_URL, with {to} and {text}
 * where the number and the message go) — which is how most Malaysian
 * aggregators work, and they are cheaper for Malaysian numbers.
 */
export type SmsConfig =
  | { kind: "twilio"; accountSid: string; authToken: string; from: string }
  | { kind: "http"; url: string };

export function smsConfig(): SmsConfig | null {
  const sid = process.env.SMS_TWILIO_ACCOUNT_SID;
  const token = process.env.SMS_TWILIO_AUTH_TOKEN;
  const from = process.env.SMS_FROM;
  if (sid && token && from) return { kind: "twilio", accountSid: sid, authToken: token, from };
  const url = process.env.SMS_HTTP_URL;
  if (url && url.includes("{to}") && url.includes("{text}")) return { kind: "http", url };
  return null;
}

/**
 * Malaysian rules want a text from a business to start with "RM0" — it costs
 * the reader nothing — and say who it is from. SMS_PREFIX changes the first
 * part; set it to an empty string to leave it off outside Malaysia.
 */
export function smsText(body: string): string {
  const prefix = process.env.SMS_PREFIX ?? region().smsPrefix;
  return prefix ? `${prefix} ${body}` : body;
}

/** One text. Throws with the gateway's reason when it is refused. */
export async function sendSms(config: SmsConfig, to: string, text: string): Promise<void> {
  const number = toWhatsAppNumber(to);
  let res: Response;
  if (config.kind === "twilio") {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: `+${number}`, From: config.from, Body: text }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } else {
    res = await fetch(config.url.replace("{to}", encodeURIComponent(number)).replace("{text}", encodeURIComponent(text)), {
      signal: AbortSignal.timeout(15_000),
    });
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`The SMS was not sent (${res.status})${detail ? `: ${detail}` : ""}.`);
  }
}
