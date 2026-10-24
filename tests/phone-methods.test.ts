import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, createSession, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  codesPerDay,
  phoneChecksOn,
  phoneMethods,
  phoneStatus,
  sendPhoneCode,
  startWhatsappCheck,
  verifyFromWhatsapp,
} from "../src/lib/phone-check";
import { sendSms, smsConfig, smsText } from "../src/lib/transports";
import { resetRateLimits } from "../src/lib/rate-limit";

/** Proving a phone number: a message from it on WhatsApp, or a code by SMS. */

let n = 0;
async function account(phone = "0123456789") {
  const made = await registerUser({ name: `Holder ${++n}`, email: `m${n}@x.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}
function whatsappVerify() {
  vi.stubEnv("WHATSAPP_CHAT_NUMBER", "+60 11-2345 6789");
  vi.stubEnv("WHATSAPP_APP_SECRET", "app-secret");
}

beforeAll(async () => await ensureBootstrapAdmin());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetRateLimits();
});

describe("the ways offered", () => {
  it("are whatever is set up, and checks are on when any is", () => {
    expect(phoneMethods()).toEqual({ whatsapp: false, code: false, codeBy: "whatsapp" });
    expect(phoneChecksOn()).toBe(false);
    whatsappVerify();
    expect(phoneMethods()).toMatchObject({ whatsapp: true, code: false });
    expect(phoneChecksOn()).toBe(true);
    vi.stubEnv("SMS_HTTP_URL", "https://sms.example.my/send?to={to}&msg={text}");
    expect(phoneMethods()).toEqual({ whatsapp: true, code: true, codeBy: "sms" });
    vi.unstubAllEnvs();
    vi.stubEnv("WHATSAPP_TOKEN", "t");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1");
    expect(phoneMethods()).toEqual({ whatsapp: false, code: true, codeBy: "whatsapp" });
    vi.stubEnv("MYSENAM_PHONE_CHECK", "off");
    expect(phoneChecksOn()).toBe(false);
  });
});

describe("verifying via WhatsApp", () => {
  it("is done by a message from that number with the token in it, and nothing else", async () => {
    const user = await account("012-444 0001");
    expect(await startWhatsappCheck(user.id, "012-444 0001")).toMatchObject({ ok: false });
    whatsappVerify();
    expect(await startWhatsappCheck(user.id, "not a phone")).toMatchObject({ ok: false });
    const started = await startWhatsappCheck(user.id, "012-444 0001", "ms");
    if (!started.ok) throw new Error(started.error);
    expect(started.token).toMatch(/^V-[A-Z2-9]{6}$/);
    expect(started.text).toBe(`Sahkan nombor saya: ${started.token}`);
    expect(started.link).toBe(`https://wa.me/601123456789?text=${encodeURIComponent(started.text)}`);

    // From somebody else's phone, or with no token, it proves nothing.
    expect(await verifyFromWhatsapp("60199999999", started.text)).toBe(false);
    expect(await verifyFromWhatsapp("60124440001", "hello")).toBe(false);
    expect(await verifyFromWhatsapp("not a number", started.text)).toBe(false);
    expect(await verifyFromWhatsapp("60124440001", "Verify my number: V-ZZZZZZ")).toBe(false);
    expect((await phoneStatus(user.id))!.verified).toBe(false);

    // From the phone itself: checked.
    expect(await verifyFromWhatsapp("60124440001", `  verify my number: ${started.token.toLowerCase()} `)).toBe(true);
    expect(await phoneStatus(user.id)).toMatchObject({ verified: true, checks: true });
    // Used: a second message changes nothing.
    expect(await verifyFromWhatsapp("60124440001", started.text)).toBe(false);
  });

  it("runs out, and is limited per account", async () => {
    whatsappVerify();
    const user = await account("012-444 0002");
    const started = await startWhatsappCheck(user.id, "012-444 0002");
    if (!started.ok) throw new Error(started.error);
    await getDb().prepare("UPDATE phone_codes SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(user.id);
    expect(await verifyFromWhatsapp("60124440002", started.text)).toBe(false);
    for (let i = 1; i < 6; i++) expect((await startWhatsappCheck(user.id, "012-444 0002")).ok).toBe(true);
    expect(await startWhatsappCheck(user.id, "012-444 0002")).toMatchObject({ ok: false, code: "PHONE_CODE_LIMIT" });
  });

  it("arrives through Meta's signed webhook, and the route hands out the link", async () => {
    whatsappVerify();
    const user = await account("012-444 0003");
    const cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
    const phone = await import("../src/app/api/my/phone/route");
    const res = await phone.POST(
      new NextRequest("http://localhost/api/my/phone", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "whatsapp", phone: "012-444 0003" }) })
    );
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.link).toContain("https://wa.me/601123456789?text=");
    expect(out.status.methods).toMatchObject({ whatsapp: true });

    const hook = await import("../src/app/api/whatsapp/webhook/route");
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "60124440003", type: "text", text: { body: out.text } }] } }] }] });
    const posted = await hook.POST(
      new NextRequest("http://localhost/api/whatsapp/webhook", {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}` },
      })
    );
    expect(await posted.json()).toMatchObject({ verified: 1, answered: 0 });
    expect((await phoneStatus(user.id))!.verified).toBe(true);

    vi.unstubAllEnvs();
    const refused = await phone.POST(
      new NextRequest("http://localhost/api/my/phone", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "whatsapp", phone: "012-444 0003" }) })
    );
    expect(refused.status).toBe(400);
  });
});

describe("a code by SMS", () => {
  it("goes through Twilio or a plain HTTP gateway, starting RM0 as Malaysian rules want", async () => {
    expect(smsConfig()).toBeNull();
    vi.stubEnv("SMS_HTTP_URL", "https://sms.example.my/send?to=noplaceholder");
    expect(smsConfig()).toBeNull();
    expect(smsText("MySenam: code 123456")).toBe("RM0 MySenam: code 123456");
    vi.stubEnv("SMS_PREFIX", "");
    expect(smsText("hi")).toBe("hi");

    const fetchMock = vi.fn(async () => new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendSms({ kind: "http", url: "https://sms.example.my/send?to={to}&msg={text}" }, "012-345 6789", "RM0 hello there");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://sms.example.my/send?to=60123456789&msg=RM0%20hello%20there");

    await sendSms({ kind: "twilio", accountSid: "AC1", authToken: "secret", from: "MySenam" }, "0123456789", "RM0 code");
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("AC1:secret").toString("base64")}`);
    expect(String(init.body)).toBe("To=%2B60123456789&From=MySenam&Body=RM0+code");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("insufficient credit", { status: 402 })));
    await expect(sendSms({ kind: "http", url: "https://x/{to}/{text}" }, "0123456789", "x")).rejects.toThrow(/402.*insufficient credit/);

    vi.stubEnv("SMS_TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("SMS_TWILIO_AUTH_TOKEN", "secret");
    vi.stubEnv("SMS_FROM", "MySenam");
    expect(smsConfig()).toMatchObject({ kind: "twilio" });
  });

  it("is what a code goes by once SMS is set up, in the customer's language", async () => {
    vi.stubEnv("SMS_HTTP_URL", "https://sms.example.my/send?to={to}&msg={text}");
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (sent.push(decodeURIComponent(url)), new Response("OK"))));
    const user = await account("012-444 0004");
    expect(await sendPhoneCode(user.id, "012-444 0004", "ms")).toEqual({ ok: true, sent: true });
    expect(sent[0]).toMatch(/to=60124440004&msg=RM0 MySenam: kod anda ialah \d{6}\. Sah selama 10 minit\./);
  });
});

describe("the site's daily ceiling on codes", () => {
  it("stops codes, tells the owner once, and points customers to WhatsApp", async () => {
    vi.stubEnv("MYSENAM_SEND", "log");
    vi.stubEnv("MYSENAM_PHONE_CHECK", "on");
    vi.stubEnv("MYSENAM_PHONE_CODES_PER_DAY", "nonsense");
    expect(codesPerDay()).toBe(300);
    await getDb().prepare("DELETE FROM phone_codes").run();
    vi.stubEnv("MYSENAM_PHONE_CODES_PER_DAY", "2");
    const a = await account("012-555 1001");
    const b = await account("012-555 1002");
    expect((await sendPhoneCode(a.id, "012-555 1001")).ok).toBe(true);
    expect((await sendPhoneCode(b.id, "012-555 1002")).ok).toBe(true);
    expect(await sendPhoneCode(a.id, "012-555 1001")).toMatchObject({ ok: false, code: "PHONE_CODES_PAUSED" });
    expect(await sendPhoneCode(b.id, "012-555 1002")).toMatchObject({ ok: false, code: "PHONE_CODES_PAUSED" });
    // Queued in the outbox for the owners, like every alert to them.
    const alerts = (await getDb()
      .prepare("SELECT recipient FROM messages WHERE kind = 'staff_alert' AND subject LIKE '%Phone codes paused for today%'")
      .all()) as { recipient: string }[];
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    // Once per owner, not once per refusal.
    expect(alerts.length).toBe(new Set(alerts.map((r) => r.recipient)).size);
  });
});
