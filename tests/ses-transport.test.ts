import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

process.env.MYSENAM_DB = ":memory:";

import { amzDate, signV4 } from "../src/lib/offsite";
import { SesError, sesCall, sesConfigFromEnv, sesHost } from "../src/lib/ses";
import type { SesConfig } from "../src/lib/ses";
import { emailConfig, emailTransport } from "../src/lib/transports";
import { drainOutbox, emailPlain, maxMessageAgeDays, setTransport } from "../src/lib/outbox";
import type { OutboxMessage } from "../src/lib/outbox";
import { getDb } from "../src/lib/db";

/**
 * Email through Amazon SES's HTTPS API.
 *
 * Nothing here reaches Amazon: fetch is stood in for, so what is checked is what
 * would have been sent, and how an answer is read. That is not a live check of SES.
 */

const KEY_ID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const TOKEN = "IQoJb3JpZ2luX2VjEXAMPLETOKEN";

const config: SesConfig = {
  kind: "ses",
  region: "ap-southeast-1",
  accessKeyId: KEY_ID,
  secretAccessKey: SECRET,
  from: "Arena <bookings@arena.my>",
};

const ENV_KEYS = [
  "SES_ACCESS_KEY_ID",
  "SES_SECRET_ACCESS_KEY",
  "SES_REGION",
  "SES_SESSION_TOKEN",
  "SES_CONFIGURATION_SET",
  "SMTP_URL",
  "MAIL_FROM",
  "MYSENAM_SEND",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setTransport(null);
});

function message(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 1,
    bookingId: 1,
    venueId: 1,
    kind: "booking_confirmed",
    channel: "email",
    recipient: "aina@example.com",
    locale: "en",
    subject: "Booking ABC confirmed",
    body: "Hi Aina, your booking ABC is confirmed. Café court 1.",
    params: null,
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

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records each request and answers with the given replies in turn (the last one repeats). */
function standIn(...replies: (() => Response)[]) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body as string | undefined,
    });
    return replies[Math.min(seen.length - 1, replies.length - 1)]();
  });
  vi.stubGlobal("fetch", fetchMock);
  return seen;
}

const ok = (id = "0100018b-example-id") => () =>
  new Response(JSON.stringify({ MessageId: id }), { status: 200, headers: { "content-type": "application/json" } });
const refused = (status: number, type: string, text: string) => () =>
  new Response(JSON.stringify({ message: text }), {
    status,
    headers: { "content-type": "application/json", "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.sesv2/` },
  });

/** The MIME of the message that was sent, as text. */
function mimeOf(seen: Seen): string {
  const sent = JSON.parse(seen.body!);
  return Buffer.from(sent.Content.Raw.Data, "base64").toString("utf8");
}

describe("the signature", () => {
  it("matches Amazon's published test vector (get-vanilla)", () => {
    // From the AWS Signature Version 4 test suite: a GET of / with only host and x-amz-date signed.
    const auth = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: crypto.createHash("sha256").update("").digest("hex"),
      region: "us-east-1",
      service: "service",
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    );
  });

  it("signs a SES POST over the canonical request written out by hand", async () => {
    const seen = standIn(ok());
    const now = new Date("2026-10-31T04:05:06Z");
    await sesCall({ ...config, sessionToken: TOKEN }, { method: "POST", path: "/v2/email/outbound-emails", json: { a: 1 } }, now);
    const [request] = seen;
    const body = '{"a":1}';
    expect(request.body).toBe(body);

    // The canonical request, line by line: method, path, (no) query, headers sorted by name, the names, the body's hash.
    const canonical = [
      "POST",
      "/v2/email/outbound-emails",
      "",
      "content-type:application/json",
      "host:email.ap-southeast-1.amazonaws.com",
      "x-amz-date:20261031T040506Z",
      `x-amz-security-token:${TOKEN}`,
      "",
      "content-type;host;x-amz-date;x-amz-security-token",
      crypto.createHash("sha256").update(body).digest("hex"),
    ].join("\n");
    const scope = "20261031/ap-southeast-1/ses/aws4_request";
    const toSign = ["AWS4-HMAC-SHA256", "20261031T040506Z", scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
    const hmac = (k: crypto.BinaryLike, d: string) => crypto.createHmac("sha256", k).update(d).digest();
    const signing = hmac(hmac(hmac(hmac("AWS4" + SECRET, "20261031"), "ap-southeast-1"), "ses"), "aws4_request");
    const signature = crypto.createHmac("sha256", signing).update(toSign).digest("hex");
    expect(request.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=${signature}`
    );
  });

  it("writes the date the way AWS wants it", () => {
    expect(amzDate(new Date("2026-10-31T04:05:06.789Z"))).toBe("20261031T040506Z");
  });
});

describe("the request", () => {
  it("is a SigV4-signed POST of SendEmail with the finished message", async () => {
    const seen = standIn(ok("msg-123"));
    const out = await emailTransport(config).send(message());
    expect(out).toEqual({ providerId: "msg-123" });

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request.url).toBe("https://email.ap-southeast-1.amazonaws.com/v2/email/outbound-emails");
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(request.headers["x-amz-security-token"]).toBeUndefined();
    const auth = request.headers.authorization;
    expect(auth).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/ap-southeast-1/ses/aws4_request, `));
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date,");
    // The secret itself is never sent, only what it signs.
    expect(JSON.stringify(request)).not.toContain(SECRET);

    const sent = JSON.parse(request.body!);
    expect(Object.keys(sent).sort()).toEqual(["Content", "Destination", "FromEmailAddress"]);
    expect(sent.FromEmailAddress).toBe("Arena <bookings@arena.my>");
    expect(sent.Destination).toEqual({ ToAddresses: ["aina@example.com"] });
    expect(Object.keys(sent.Content)).toEqual(["Raw"]);
    expect(sent.Content.Raw.Data).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("carries the session token and the configuration set when there are some", async () => {
    const seen = standIn(ok());
    await emailTransport({ ...config, sessionToken: TOKEN, configurationSet: "mysenam-events" }).send(message());
    expect(seen[0].headers["x-amz-security-token"]).toBe(TOKEN);
    expect(seen[0].headers.authorization).toContain("x-amz-security-token");
    expect(JSON.parse(seen[0].body!).ConfigurationSetName).toBe("mysenam-events");
  });

  it("holds the same message as SMTP would send: from, to, subject, text", async () => {
    const seen = standIn(ok());
    await emailTransport(config).send(message());
    const mime = mimeOf(seen[0]);
    expect(mime).toMatch(/^From: Arena <bookings@arena\.my>\r?$/m);
    expect(mime).toMatch(/^To: aina@example\.com\r?$/m);
    expect(mime).toMatch(/^Subject: Booking ABC confirmed\r?$/m);
    expect(mime).toMatch(/^Content-Type: text\/plain; charset=utf-8\r?$/m);
    // The text, whichever encoding nodemailer chose for the accented letter.
    const part = mime.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    const decoded = /quoted-printable/i.test(mime)
      ? part.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      : /base64/i.test(mime)
        ? Buffer.from(part.replace(/\s+/g, ""), "base64").toString("utf8")
        : part;
    expect(Buffer.from(decoded, "latin1").toString("utf8")).toContain("Hi Aina, your booking ABC is confirmed.");
    expect(mime).not.toContain("text/calendar");
  });

  it("holds the calendar invite as a .ics part", async () => {
    const seen = standIn(ok());
    await emailTransport(config).send(message({ calendar: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR" }));
    const mime = mimeOf(seen[0]);
    expect(mime).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=PUBLISH/i);
    expect(mime).toContain("filename=booking.ics");
    expect(mime).toContain("BEGIN:VCALENDAR");
  });

  it("gives a campaign the one-click unsubscribe headers, and nothing else gets them", async () => {
    const seen = standIn(ok());
    const link = "https://mysenam.example/unsubscribe/abc123-def";
    await emailTransport(config).send(message({ kind: "campaign", params: { link } }));
    const mime = mimeOf(seen[0]);
    expect(mime).toMatch(/^List-Unsubscribe: <https:\/\/mysenam\.example\/api\/unsubscribe\/abc123-def>\r?$/m);
    expect(mime).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r?$/m);

    await emailTransport(config).send(message({ kind: "booking_confirmed", params: { link } }));
    expect(mimeOf(seen[1])).not.toContain("List-Unsubscribe");
  });

  it("refuses something that is not an address before calling anyone", async () => {
    const seen = standIn(ok());
    await expect(emailTransport(config).send(message({ recipient: "0123456789" }))).rejects.toThrow(/not an email address/);
    expect(seen).toHaveLength(0);
  });

  it("logs and says nothing of a credential", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    standIn(refused(403, "UnrecognizedClientException", `The security token included in the request is invalid. ${SECRET} ${TOKEN}`));
    let error = "";
    await emailTransport({ ...config, sessionToken: TOKEN }).send(message()).catch((e: Error) => (error = e.message));
    expect(error).toMatch(/Amazon SES refused it \(403\)/);
    for (const text of [error, ...logged]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("which way email goes", () => {
  const ses = () => {
    process.env.SES_ACCESS_KEY_ID = KEY_ID;
    process.env.SES_SECRET_ACCESS_KEY = SECRET;
    process.env.SES_REGION = "ap-southeast-1";
    process.env.MAIL_FROM = "Arena <bookings@arena.my>";
  };

  it("is neither set up with nothing set", () => {
    expect(emailConfig()).toBeNull();
    expect(sesConfigFromEnv()).toBeNull();
  });

  it("is SMTP with SMTP_URL and MAIL_FROM", () => {
    process.env.SMTP_URL = "smtp://u:p@mail.example.com:587";
    process.env.MAIL_FROM = "a@b.my";
    expect(emailConfig()).toEqual({ kind: "smtp", url: "smtp://u:p@mail.example.com:587", from: "a@b.my" });
  });

  it("is SES with its four settings, and takes the optional two", () => {
    ses();
    expect(emailConfig()).toEqual({
      kind: "ses",
      region: "ap-southeast-1",
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      sessionToken: undefined,
      configurationSet: undefined,
      from: "Arena <bookings@arena.my>",
    });
    process.env.SES_SESSION_TOKEN = TOKEN;
    process.env.SES_CONFIGURATION_SET = "mysenam-events";
    expect(emailConfig()).toMatchObject({ kind: "ses", sessionToken: TOKEN, configurationSet: "mysenam-events" });
  });

  it("wins over SMTP when both are set", () => {
    ses();
    process.env.SMTP_URL = "smtp://u:p@mail.example.com:587";
    expect(emailConfig()?.kind).toBe("ses");
  });

  it("is not SES with any one of the four missing, and falls back to SMTP", () => {
    for (const missing of ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "MAIL_FROM"]) {
      ses();
      delete process.env[missing];
      expect(emailConfig(), missing).toBeNull();
      // SMTP needs MAIL_FROM too, so with it gone there is no email at all, SMTP_URL or not.
      process.env.SMTP_URL = "smtp://u:p@mail.example.com:587";
      expect(emailConfig()?.kind ?? null, missing).toBe(missing === "MAIL_FROM" ? null : "smtp");
      delete process.env.SMTP_URL;
    }
  });

  it("ignores the AWS_* names, which other tools on the machine set (even to placeholders)", () => {
    process.env.AWS_ACCESS_KEY_ID = "placeholder";
    process.env.AWS_SECRET_ACCESS_KEY = "placeholder";
    process.env.AWS_REGION = "ap-southeast-1";
    process.env.MAIL_FROM = "a@b.my";
    expect(emailConfig()).toBeNull();
  });

  it("names itself email either way, so the outbox's transport name is unchanged", () => {
    ses();
    expect(emailTransport(emailConfig()!).name).toBe("email");
  });
});

describe("what SES says no with", () => {
  async function failure(reply: () => Response): Promise<SesError> {
    standIn(reply);
    return (await emailTransport(config).send(message()).then(
      () => null,
      (e: unknown) => e
    )) as SesError;
  }

  it("a throttle is reported as one, with its words and the status, so the outbox tries again", async () => {
    const err = await failure(refused(429, "TooManyRequestsException", "Maximum sending rate exceeded."));
    expect(err).toBeInstanceOf(SesError);
    expect(err.status).toBe(429);
    expect(err.transient).toBe(true);
    expect(err.message).toBe("Amazon SES is throttling or unavailable (429): Maximum sending rate exceeded.");
    // A throttle that comes as a 400 is one too.
    const named = await failure(refused(400, "ThrottlingException", "Slow down."));
    expect(named.transient).toBe(true);
  });

  it("the sandbox refusing an unverified address is a plain failure with SES's reason", async () => {
    const err = await failure(
      refused(400, "MessageRejected", "Email address is not verified. The following identities failed the check in region AP-SOUTHEAST-1: aina@example.com")
    );
    expect(err.transient).toBe(false);
    expect(err.status).toBe(400);
    expect(err.type).toBe("MessageRejected");
    expect(err.message).toBe(
      "Amazon SES refused it (400): Email address is not verified. The following identities failed the check in region AP-SOUTHEAST-1: aina@example.com"
    );
  });

  it("a 5xx is SES's own trouble", async () => {
    const err = await failure(refused(503, "ServiceUnavailable", "Service unavailable."));
    expect(err.transient).toBe(true);
    expect(err.message).toContain("(503)");
    const bare = await failure(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(bare.transient).toBe(true);
    expect(bare.message).toBe("Amazon SES is throttling or unavailable (502): no reason given");
  });

  it("a key SES does not accept is reported with the status", async () => {
    const err = await failure(refused(403, "UnrecognizedClientException", "The security token included in the request is invalid."));
    expect(err.message).toBe("Amazon SES refused it (403): The security token included in the request is invalid.");
    expect(err.transient).toBe(false);
  });

  it("no answer in time says so, and an unreachable SES says that", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );
    await expect(emailTransport(config).send(message())).rejects.toThrow("Amazon SES did not answer within 15 seconds.");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed ${SECRET}`);
      })
    );
    const err = (await emailTransport(config).send(message()).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^Amazon SES could not be reached: fetch failed/);
    expect(err.message).not.toContain(SECRET);
  });

  it("sends with a 15 second time limit", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    standIn(ok());
    await emailTransport(config).send(message());
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
});

describe("the region", () => {
  it("is checked before it becomes part of a host name", async () => {
    for (const region of ["ap-southeast-1", "us-east-1", "eu-west-2", "us-gov-west-1", "ap-southeast-5"])
      expect(sesHost(region)).toBe(`email.${region}.amazonaws.com`);
    for (const bad of ["", "localhost", "evil.example.com/x#", "ap-southeast-1.evil.com", "AP-SOUTHEAST-1", "ap-southeast", "us-east-1\n", "a b-1"])
      expect(() => sesHost(bad), JSON.stringify(bad)).toThrow(/not an AWS region/);
  });

  it("refuses a bad region without making any request", async () => {
    const seen = standIn(ok());
    await expect(emailTransport({ ...config, region: "ap-southeast-1.evil.example" }).send(message())).rejects.toThrow(/SES_REGION/);
    expect(seen).toHaveLength(0);
  });
});

describe("the outbox with SES behind it", () => {
  async function queued(key: string): Promise<number> {
    const m = await emailPlain({ to: "aina@example.com", subject: "Your password reset", text: "Open the link.", kind: "account_email", dedupeKey: key });
    return m.id;
  }
  const row = async (id: number) =>
    (await getDb().prepare("SELECT status, attempts, last_error, provider_id FROM messages WHERE id = ?").get(id)) as {
      status: string;
      attempts: number;
      last_error: string | null;
      provider_id: string | null;
    };
  const due = (id: number) => getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now') WHERE id = ?").run(id);

  beforeEach(() => {
    process.env.SES_ACCESS_KEY_ID = KEY_ID;
    process.env.SES_SECRET_ACCESS_KEY = SECRET;
    process.env.SES_REGION = "ap-southeast-1";
    process.env.MAIL_FROM = "Arena <bookings@arena.my>";
  });

  it("goes from queued to sent, with SES's id kept", async () => {
    const id = await queued("ses-ok");
    expect((await row(id)).status).toBe("queued");
    const seen = standIn(ok("ses-id-1"));
    const result = await drainOutbox();
    expect(result.transport).toBe("email");
    expect(result.sent).toBe(1);
    expect(seen).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 1, last_error: null, provider_id: "ses-id-1" });
    expect(mimeOf(seen[0])).toMatch(/^Subject: Your password reset\r?$/m);
  });

  it("a throttle is retried, not lost", async () => {
    const id = await queued("ses-throttle");
    standIn(refused(429, "TooManyRequestsException", "Maximum sending rate exceeded."), ok("ses-id-2"));
    const first = await drainOutbox();
    expect(first.failed).toBe(1);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1, provider_id: null });
    expect((await row(id)).last_error).toBe("Amazon SES is throttling or unavailable (429): Maximum sending rate exceeded.");
    // Not due yet: a second drain leaves it alone.
    expect((await drainOutbox()).sent).toBe(0);
    await due(id);
    const second = await drainOutbox();
    expect(second.sent).toBe(1);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2, last_error: null, provider_id: "ses-id-2" });
  });

  it("a sandbox rejection is the account's to put right: kept and retried, then abandoned with its reason once it is too old", async () => {
    const id = await queued("ses-sandbox");
    standIn(refused(400, "MessageRejected", "Email address is not verified."));
    for (let i = 0; i < 7; i++) {
      await due(id);
      await drainOutbox();
    }
    // Seven failures later it is still waiting: the number of tries no longer gives a message up.
    expect(await row(id)).toMatchObject({
      status: "failed",
      attempts: 7,
      last_error: "Amazon SES refused it (400): Email address is not verified.",
    });
    // Past the longest it is kept trying, the next failure gives it up, with the reason.
    await getDb().prepare("UPDATE messages SET created_at = datetime('now', ?) WHERE id = ?").run(`-${maxMessageAgeDays() + 1} days`, id);
    await due(id);
    await drainOutbox();
    expect(await row(id)).toMatchObject({
      status: "abandoned",
      attempts: 8,
      last_error: `Amazon SES refused it (400): Email address is not verified. (given up after ${maxMessageAgeDays()} days of trying)`,
    });
  });
});
