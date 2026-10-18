import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";

const sendMail = vi.fn(async () => ({ messageId: "x" }));
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import {
  TEMPLATE_PHRASES,
  emailTransport,
  placeholders,
  templateParam,
  templateText,
  toWhatsAppNumber,
  whatsappTransport,
} from "../src/lib/transports";
import { drainOutbox, messagesForBooking, transport } from "../src/lib/outbox";
import { setWhatsappOn } from "../src/lib/whatsapp-credit";
import type { MessageKind, OutboxMessage } from "../src/lib/outbox";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { createBooking, listVenues } from "../src/lib/store";
import { DICTIONARIES, LOCALES } from "../src/lib/i18n";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The two ways a message actually leaves: WhatsApp and email.
 *
 * Nothing here talks to Meta or a mail server — fetch and nodemailer are
 * stood in for — so what is checked is what we would have sent them.
 */

const KINDS = Object.keys(TEMPLATE_PHRASES) as MessageKind[];
const ENV_KEYS = [
  "MYSENAM_SEND",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_TEMPLATE_PREFIX",
  "WHATSAPP_COUNTRY_CODE",
  "SMTP_URL",
  "MAIL_FROM",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  sendMail.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

function message(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 1,
    bookingId: 1,
    venueId: 1,
    kind: "booking_cancelled",
    channel: "whatsapp",
    recipient: "012-345 6789",
    locale: "en",
    subject: "Booking ABC cancelled",
    body: "Hi Aina, booking ABC has been cancelled.",
    params: {
      name: "Aina",
      code: "ABC123",
      where: "Court 1 at Arena",
      when: "2026-10-20, 10:00 to 11:00",
    },
    status: "queued",
    dedupeKey: null,
    attempts: 0,
    lastError: null,
    createdAt: "",
    nextAttemptAt: "",
    sentAt: null,
    free: false,
    calendar: null,
    deliveredAt: null,
    readAt: null,
    deliveryError: null,
    ...over,
  };
}

describe("the templates Meta is asked to approve", () => {
  for (const kind of KINDS) {
    for (const locale of LOCALES) {
      it(`${kind} (${locale}) is one Meta will accept`, () => {
        const phrase = DICTIONARIES[locale][TEMPLATE_PHRASES[kind]!];
        const t = templateText(kind, locale);
        // Neither starts nor ends on a parameter: Meta rejects a dangling one.
        expect(t.body.trimStart()).not.toMatch(/^\{\{/);
        expect(t.body.trimEnd()).not.toMatch(/\}\}[.!?]?$/);
        // Each placeholder used once, so {{n}} counts up without gaps or repeats.
        expect(phrase.match(/\{\w+\}/g)!.length).toBe(t.params.length);
        // Few enough parameters for the length.
        expect(t.params.length).toBeLessThanOrEqual(7);
        expect(t.body.length).toBeLessThanOrEqual(550);
      });
    }

    it(`${kind} fills the same parameters in both languages`, () => {
      expect(new Set(templateText(kind, "ms").params)).toEqual(
        new Set(templateText(kind, "en").params)
      );
    });
  }

  it("is what the README tells you to submit", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    for (const kind of KINDS)
      for (const locale of LOCALES) {
        const t = templateText(kind, locale);
        expect(readme, `${t.name} (${locale}) in README`).toContain("```text\n" + t.body + "\n```");
      }
  });

  it("names placeholders in the order they first appear", () => {
    expect(placeholders("Hi {name}, {code} — {name}")).toEqual(["name", "code"]);
  });
});

describe("a phone number WhatsApp will take", () => {
  it.each([
    ["012-345 6789", "60123456789"],
    ["0123456789", "60123456789"],
    ["+60 12-345 6789", "60123456789"],
    ["60123456789", "60123456789"],
    ["0065 9123 4567", "6591234567"],
    ["+65 9123 4567", "6591234567"],
    ["123456789", "60123456789"],
  ])("%s → %s", (typed, sent) => {
    expect(toWhatsAppNumber(typed)).toBe(sent);
  });

  it("takes another country as the default", () => {
    process.env.WHATSAPP_COUNTRY_CODE = "+65";
    expect(toWhatsAppNumber("09123 4567")).toBe("6591234567");
  });
});

describe("a template parameter", () => {
  it("is flattened to one line", () => {
    expect(templateParam("Court 1\nat Arena")).toBe("Court 1 · at Arena");
    expect(templateParam("a\t\tb")).toBe("a · b");
    expect(templateParam("a      b")).toBe("a b");
  });

  it("is never empty", () => {
    expect(templateParam("")).toBe("-");
    expect(templateParam(undefined)).toBe("-");
    expect(templateParam(40)).toBe("40");
  });
});

describe("sending on WhatsApp", () => {
  const config = { token: "tok", phoneNumberId: "555", apiVersion: "v23.0" };

  it("posts the template with its parameters in order", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappTransport(config).send(message({ locale: "ms" }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/555/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("60123456789");
    expect(body.template.name).toBe("mysenam_booking_cancelled");
    expect(body.template.language.code).toBe("ms");
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(
      templateText("booking_cancelled", "ms").params.map(
        (key) => message().params![key] as string
      )
    );
  });

  it("uses the configured template prefix", async () => {
    process.env.WHATSAPP_TEMPLATE_PREFIX = "Arena";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappTransport(config).send(message());
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.template.name).toBe("arena_booking_cancelled");
  });

  it("fails with Meta's reason, so staff can see why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "(#132001) Template name does not exist in the translation" } },
          { status: 404 }
        )
      )
    );
    await expect(whatsappTransport(config).send(message())).rejects.toThrow(
      /WhatsApp refused it \(404\): .*Template name does not exist/
    );
  });

  it("answers a chat the customer opened with the finished text, not a template", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappTransport(config).send(message({ free: true, params: null }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "60123456789",
      type: "text",
      text: { body: "Hi Aina, booking ABC has been cancelled.", preview_url: false },
    });
  });

  it("will not guess at a message written before templates", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(whatsappTransport(config).send(message({ params: null }))).rejects.toThrow(
      /before WhatsApp templates/
    );
  });
});

describe("sending by email", () => {
  const config = { url: "smtp://u:p@mail.example.com:587", from: "Arena <bookings@arena.my>" };

  it("sends the finished text with its subject", async () => {
    await emailTransport(config).send(
      message({ channel: "email", recipient: "aina@example.com" })
    );
    expect(sendMail).toHaveBeenCalledWith({
      from: "Arena <bookings@arena.my>",
      to: "aina@example.com",
      subject: "Booking ABC cancelled",
      text: "Hi Aina, booking ABC has been cancelled.",
    });
  });

  it("attaches the booking as a calendar invite", async () => {
    await emailTransport(config).send(
      message({ channel: "email", recipient: "aina@example.com", calendar: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" })
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ icalEvent: { filename: "booking.ics", method: "PUBLISH", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" } })
    );
  });

  it("refuses an address that is not one", async () => {
    await expect(
      emailTransport(config).send(message({ channel: "email", recipient: "0123456789" }))
    ).rejects.toThrow(/not an email address/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("choosing how to reach a customer", () => {
  let venueId: number;
  let courtId: number;
  let hour = 9;
  beforeAll(async () => {
    const venue = (await listVenues())[0];
    venueId = venue.id;
    courtId = venue.courts.find((c) => c.capacity === 1)!.id;
  });
  afterEach(async () => await setWhatsappOn(venueId, false));

  async function confirm(email?: string) {
    const made = await createBooking({ courtId, date: addDays(todayISO(), 6), hours: [hour++], name: "Aina", phone: "0123456789", email });
    if (!made.ok) throw new Error(made.error);
    await notifyBookingConfirmed([made.booking], "en", null);
    return (await messagesForBooking(made.booking.id)).map((m) => [m.channel, m.recipient, m.calendar !== null]);
  }

  it("emails anyone who gave an address, with the booking in a calendar file", async () => {
    process.env.SMTP_URL = "smtp://x";
    process.env.MAIL_FROM = "a@b.my";
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
    // WhatsApp is set up on the site, but this venue has not switched it on.
    expect(await confirm("aina@example.com")).toEqual([["email", "aina@example.com", true]]);
  });

  it("writes nothing for a phone-only customer while WhatsApp is off: the code is on their screen", async () => {
    expect(await confirm()).toEqual([]);
  });

  it("adds WhatsApp when the venue has switched it on", async () => {
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
    await setWhatsappOn(venueId, true);
    expect(await confirm("aina@example.com")).toEqual([
      ["email", "aina@example.com", true],
      ["whatsapp", "0123456789", false],
    ]);
    expect(await confirm()).toEqual([["whatsapp", "0123456789", false]]);
  });

  it("names what is switched on", () => {
    expect(transport()).toBeNull();
    process.env.SMTP_URL = "smtp://x";
    process.env.MAIL_FROM = "a@b.my";
    expect(transport()!.name).toBe("email");
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
    expect(transport()!.name).toBe("whatsapp+email");
    process.env.MYSENAM_SEND = "log";
    expect(transport()!.name).toBe("log");
  });
});

describe("a confirmation, end to end", () => {
  let courtId: number;
  beforeAll(async () => {
    courtId = (await listVenues())[0].courts.find((c) => c.capacity === 1)!.id;
  });

  it("keeps what filled the text, and sends it as the template's parameters", async () => {
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "555";
    await setWhatsappOn((await listVenues())[0].id, true);
    const made = await createBooking({
      courtId,
      date: addDays(todayISO(), 3),
      hours: [14],
      name: "Aina Zahra",
      phone: "019-888 7777",
    });
    if (!made.ok) throw new Error(made.error);
    await notifyBookingConfirmed([made.booking], "en", null);
    const [queued] = await messagesForBooking(made.booking.id);
    expect(queued.params).toMatchObject({ name: "Aina", code: made.booking.code });
    expect(queued.params!.total).toBe(`RM${made.booking.totalPrice}, pay at the counter`);

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await drainOutbox();
    expect(result.transport).toBe("whatsapp");
    expect((await messagesForBooking(made.booking.id))[0].status).toBe("sent");

    const sentBodies = fetchMock.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string)
    );
    const ours = sentBodies.find((b) => b.to === "60198887777")!;
    const texts = ours.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(texts[0]).toBe("Aina");
    expect(texts).toContain(made.booking.code);
    // The finished text and the template say the same thing.
    for (const text of texts) expect(queued.body).toContain(text);
    await setWhatsappOn((await listVenues())[0].id, false);
  });

  it("an email-only install sends no WhatsApp it cannot deliver", async () => {
    process.env.SMTP_URL = "smtp://x";
    process.env.MAIL_FROM = "a@b.my";
    // Switched on, but there is no WhatsApp account on the site to send with yet.
    await setWhatsappOn((await listVenues())[0].id, true);
    const made = await createBooking({
      courtId,
      date: addDays(todayISO(), 4),
      hours: [15],
      name: "Ravi",
      phone: "0171112222",
    });
    if (!made.ok) throw new Error(made.error);
    await notifyBookingConfirmed([made.booking], "en", null);
    await drainOutbox();
    const [msg] = await messagesForBooking(made.booking.id);
    // No email to send it to: it fails with a reason staff can act on.
    expect(msg.status).toBe("failed");
    expect(msg.lastError).toMatch(/No whatsapp account is set up/);
    await setWhatsappOn((await listVenues())[0].id, false);
  });
});
