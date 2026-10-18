import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { DICTIONARIES, Locale, Phrase } from "./i18n";
import type { MessageKind, OutboxMessage, Transport } from "./outbox";

/**
 * The real ways a message leaves the machine: WhatsApp and email.
 *
 * Both are switched on by configuration alone, and neither is required. A venue
 * that has only an SMTP account still gets its confirmations out by email; one
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
 * channels: change a phrase and the README's copy of its template, which is
 * what gets resubmitted to Meta, fails a test until it is brought up to date.
 */
export const TEMPLATE_PHRASES: Record<MessageKind, Phrase> = {
  booking_confirmed: "msg.confirmed",
  booking_series_confirmed: "msg.series",
  booking_cancelled: "msg.cancelled",
  waitlist_offer: "msg.offer",
  class_enrolled: "msg.enrolled",
};

/** The language codes Meta files a template's translations under. */
const WHATSAPP_LANGUAGE: Record<Locale, string> = { en: "en", ms: "ms" };

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
  const phrase = DICTIONARIES[locale][TEMPLATE_PHRASES[kind]];
  const params = placeholders(phrase);
  const body = phrase.replace(/\{(\w+)\}/g, (_, key: string) => `{{${params.indexOf(key) + 1}}}`);
  return { name: templateName(kind), language: WHATSAPP_LANGUAGE[locale], body, params };
}

export function templateName(kind: MessageKind): string {
  const prefix = (process.env.WHATSAPP_TEMPLATE_PREFIX || "mysenam").toLowerCase();
  return `${prefix}_${kind}`;
}

/**
 * A number WhatsApp will accept: digits only, with the country code.
 *
 * People type numbers the way they say them — `012-345 6789` — and a leading
 * 0 is the local trunk prefix, which WhatsApp does not know. Malaysia is the
 * default because that is where the venues are; WHATSAPP_COUNTRY_CODE moves it.
 */
export function toWhatsAppNumber(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  const country = (process.env.WHATSAPP_COUNTRY_CODE || "60").replace(/\D/g, "");
  if (digits.startsWith("0")) return country + digits.slice(1);
  if (digits.startsWith(country)) return digits;
  return country + digits;
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
      await post(config, {
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
async function post(config: WhatsAppConfig, message: Record<string, unknown>): Promise<void> {
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
}

// --------------------------------------------------------------------- email

export interface EmailConfig {
  /** smtp://user:pass@host:587 or smtps://user:pass@host:465 */
  url: string;
  from: string;
}

export function emailConfig(): EmailConfig | null {
  const url = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM;
  if (!url || !from) return null;
  return { url, from };
}

let mailer: { url: string; transporter: Transporter } | null = null;

function transporterFor(url: string): Transporter {
  if (!mailer || mailer.url !== url) mailer = { url, transporter: nodemailer.createTransport(url) };
  return mailer.transporter;
}

/**
 * One email outside the outbox, for the few messages that are not to a
 * customer about a booking — a venue told its application was approved.
 * Best-effort: false when email is not set up or the server refused it, and
 * whoever is acting is told to pass the news on themselves.
 */
export async function sendPlainEmail(to: string, subject: string, text: string): Promise<boolean> {
  const config = emailConfig();
  if (!config || process.env.MYSENAM_SEND === "log") {
    if (process.env.MYSENAM_SEND === "log") console.info(`[email] → ${to}\n${subject}\n${text}\n`);
    return false;
  }
  try {
    await transporterFor(config.url).sendMail({ from: config.from, to, subject, text });
    return true;
  } catch (err) {
    console.error(`[mysenam] could not email ${to}:`, err);
    return false;
  }
}

export function emailTransport(config: EmailConfig): Transport {
  return {
    name: "email",
    async send(message: OutboxMessage) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.recipient))
        throw new Error(`${message.recipient} is not an email address.`);
      await transporterFor(config.url).sendMail({
        from: config.from,
        to: message.recipient,
        subject: message.subject ?? undefined,
        text: message.body,
        // The booking as a calendar invite: in the customer's diary in a tap,
        // with its own reminder.
        ...(message.calendar ? { icalEvent: { filename: "booking.ics", method: "PUBLISH", content: message.calendar } } : {}),
      });
    },
  };
}
