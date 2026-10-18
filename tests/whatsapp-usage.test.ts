import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { issueDueInvoices, listInvoices, messageDefaults, setVenuePlan, venuePlans } from "../src/lib/billing";
import { getDb } from "../src/lib/db";
import {
  chatHoldMinutes,
  chatNumber,
  chatRepliesOn,
  drainOutbox,
  enqueue,
  messagesForBooking,
  setTransport,
  type OutboxMessage,
} from "../src/lib/outbox";
import { createBooking, createVenue, listVenues } from "../src/lib/store";
import { answerChat } from "../src/lib/whatsapp-chat";
import { defaultIncluded, defaultMessagePrice, monthBefore, monthBounds, monthOf, usageFor, usageOf } from "../src/lib/whatsapp-usage";
import { addDays, todayISO } from "../src/lib/time";

/** WhatsApp a venue's fee includes, what past that costs, and the free way round it. */

const ENV = [
  "MYSENAM_MARKETPLACE",
  "MYSENAM_VENUE_FEE",
  "MYSENAM_WHATSAPP_INCLUDED",
  "MYSENAM_WHATSAPP_PRICE",
  "WHATSAPP_CHAT_NUMBER",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES",
];
let n = 0;
const sent: OutboxMessage[] = [];

async function venue(): Promise<number> {
  const made = await createVenue({ name: `Chatty Venue ${++n}`, area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  return made.venue.id;
}

/** `count` WhatsApp messages sent at this UTC time. */
async function sentAt(venueId: number, at: string, count: number, free = 0) {
  for (let i = 0; i < count; i++)
    await getDb()
      .prepare(
        `INSERT INTO messages (venue_id, kind, channel, recipient, body, status, sent_at, free)
         VALUES (?, 'booking_confirmed', 'whatsapp', '0123456789', 'Hi', 'sent', ?, ?)`
      )
      .run(venueId, at, free);
}

beforeAll(async () => await ensureBootstrapAdmin());
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.MYSENAM_MARKETPLACE = "on";
  process.env.MYSENAM_VENUE_FEE = "20";
  sent.length = 0;
  setTransport({ name: "test", send: async (m) => void sent.push(m) });
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  setTransport(null);
});

describe("months", () => {
  it("are Malaysia's, counted in UTC", () => {
    expect(monthOf(new Date("2026-10-31T16:30:00Z"))).toBe("2026-11");
    expect(monthBefore("2026-01")).toBe("2025-12");
    expect(monthBefore("2026-11")).toBe("2026-10");
    expect(monthBounds("2026-10")).toEqual(["2026-09-30 16:00:00", "2026-10-31 16:00:00"]);
    expect(monthBounds("2026-12")).toEqual(["2026-11-30 16:00:00", "2026-12-31 16:00:00"]);
  });

  it("have defaults the install can change", () => {
    expect([defaultIncluded(), defaultMessagePrice()]).toEqual([300, 0.08]);
    process.env.MYSENAM_WHATSAPP_INCLUDED = "500";
    process.env.MYSENAM_WHATSAPP_PRICE = "0.1";
    expect(messageDefaults()).toEqual({ included: 500, unitPrice: 0.1 });
    process.env.MYSENAM_WHATSAPP_INCLUDED = "-3";
    process.env.MYSENAM_WHATSAPP_PRICE = "lots";
    expect(messageDefaults()).toEqual({ included: 300, unitPrice: 0.08 });
  });
});

describe("a venue's WhatsApp", () => {
  it("counts templates sent in the month, not free replies, email or the unsent", async () => {
    const id = await venue();
    process.env.MYSENAM_WHATSAPP_INCLUDED = "3";
    await sentAt(id, "2026-09-30 16:00:00", 4); // 1 Oct, just after midnight in KL
    await sentAt(id, "2026-09-30 15:59:59", 5); // still September in KL
    await sentAt(id, "2026-10-10 10:00:00", 2, 1);
    await getDb()
      .prepare("INSERT INTO messages (venue_id, kind, channel, recipient, body, status, sent_at) VALUES (?, 'booking_confirmed', 'email', 'a@b.my', 'Hi', 'sent', '2026-10-10 10:00:00')")
      .run(id);
    await getDb()
      .prepare("INSERT INTO messages (venue_id, kind, channel, recipient, body, status) VALUES (?, 'booking_confirmed', 'whatsapp', '0123', 'Hi', 'failed')")
      .run(id);
    expect(await usageOf(id, "2026-10")).toEqual({ venueId: id, month: "2026-10", paid: 4, free: 2, included: 3, unitPrice: 0.08, over: 1, amount: 0.08 });
    expect((await usageOf(id, "2026-09"))!.paid).toBe(5);
    expect(await usageFor("2026-10", [])).toEqual(new Map());
    expect(await usageOf(999999)).toBeNull();
  });

  it("can have its own allowance and rate", async () => {
    const id = await venue();
    expect(await setVenuePlan(id, { monthlyFee: null, billingStartsOn: null, whatsappIncluded: 1.5 })).toMatchObject({ ok: false });
    expect(await setVenuePlan(id, { monthlyFee: null, billingStartsOn: null, whatsappPrice: 9 })).toMatchObject({ ok: false });
    expect(await setVenuePlan(id, { monthlyFee: 15, billingStartsOn: null, whatsappIncluded: 1000, whatsappPrice: 0.05 })).toEqual({ ok: true });
    let plan = (await venuePlans()).find((p) => p.venueId === id)!;
    expect(plan).toMatchObject({ whatsappIncluded: 1000, whatsappPrice: 0.05, usage: { included: 1000, unitPrice: 0.05 } });
    // Left out: unchanged. Null: back to the default.
    await setVenuePlan(id, { monthlyFee: 15, billingStartsOn: null });
    expect((await venuePlans()).find((p) => p.venueId === id)!.whatsappIncluded).toBe(1000);
    await setVenuePlan(id, { monthlyFee: 15, billingStartsOn: null, whatsappIncluded: null, whatsappPrice: null });
    plan = (await venuePlans()).find((p) => p.venueId === id)!;
    expect(plan).toMatchObject({ whatsappIncluded: null, whatsappPrice: null, usage: { included: 300, unitPrice: 0.08 } });
  });
});

describe("the invoice", () => {
  it("charges last month's messages past the allowance, and never a free month's", async () => {
    const id = await venue();
    await setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-01", whatsappIncluded: 100, whatsappPrice: 0.1 });
    await sentAt(id, "2026-09-20 10:00:00", 500); // a free month
    await sentAt(id, "2026-10-05 10:00:00", 130);
    await sentAt(id, "2026-10-06 10:00:00", 20, 1);

    const [oct] = (await issueDueInvoices(new Date("2026-10-01T01:00:00Z"))).filter((i) => i.venueId === id);
    expect(oct).toMatchObject({ period: "2026-10", amount: 20, usage: [] });

    const [nov] = (await issueDueInvoices(new Date("2026-11-01T01:00:00Z"))).filter((i) => i.venueId === id);
    expect(nov.amount).toBe(23);
    expect(nov.usage).toEqual([
      { venueId: id, venueName: expect.any(String), month: "2026-10", messages: 130, included: 100, unitPrice: 0.1, amount: 3 },
    ]);
    // Issued once, however often it is asked.
    expect((await issueDueInvoices(new Date("2026-11-02T01:00:00Z"))).filter((i) => i.venueId === id)).toEqual([]);
    expect((await listInvoices(id)).find((i) => i.period === "2026-11")!.usage).toHaveLength(1);
  });

  it("shows a month inside the allowance as nothing extra", async () => {
    const id = await venue();
    await setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-01" });
    await sentAt(id, "2026-10-05 10:00:00", 12);
    const [nov] = (await issueDueInvoices(new Date("2026-11-01T01:00:00Z"))).filter((i) => i.venueId === id);
    expect(nov).toMatchObject({ amount: 20, usage: [{ messages: 12, included: 300, amount: 0 }] });
  });

  it("puts each branch's messages on its line of the business's invoice", async () => {
    const business = (await getDb().prepare("INSERT INTO businesses (name) VALUES ('Chatty Chain')").run()).lastInsertRowid as number;
    const a = await venue();
    const b = await venue();
    for (const v of [a, b]) {
      await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, v);
      await setVenuePlan(v, { monthlyFee: null, billingStartsOn: "2026-10-01", whatsappIncluded: 10, whatsappPrice: 0.5 });
    }
    await sentAt(a, "2026-10-05 10:00:00", 14);
    await sentAt(b, "2026-10-05 10:00:00", 3);
    const [inv] = (await issueDueInvoices(new Date("2026-11-01T01:00:00Z"))).filter((i) => i.businessId === business);
    expect(inv.amount).toBe(42);
    expect(inv.lines.find((l) => l.venueId === a)!.amount).toBe(22);
    expect(inv.lines.find((l) => l.venueId === b)!.amount).toBe(20);
    expect(inv.usage.map((u) => [u.venueId, u.amount]).sort()).toEqual([[a, 2], [b, 0]].sort());
  });
});

describe("the billing route", () => {
  it("shows staff their meter and lets the owner set the allowance", async () => {
    const id = await venue();
    await sentAt(id, new Date().toISOString().replace("T", " ").slice(0, 19), 2);
    const desk = await createAdmin({ name: "Desk", email: `desk${id}@chat.my`, password: "desk-password", venueId: id });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const owner = (await listAdmins()).find((x) => x.venueId === null)!;
    const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const mod = await import("../src/app/api/admin/billing/route");
    const get = (cookie: string) => mod.GET(new NextRequest("http://localhost/api/admin/billing", { headers: { cookie } }));

    const mine = await (await get(deskCookie)).json();
    expect(mine.usage).toEqual([expect.objectContaining({ venueId: id, paid: 2, included: 300, venueName: expect.stringContaining("Chatty") })]);
    expect(mine.plans).toBeUndefined();

    const post = (cookie: string, body: object) =>
      mod.POST(new NextRequest("http://localhost/api/admin/billing", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await post(deskCookie, { action: "setPlan", venueId: id, monthlyFee: 1, billingStartsOn: null })).status).toBe(403);
    const set = await post(ownerCookie, { action: "setPlan", venueId: id, monthlyFee: "", billingStartsOn: "", whatsappIncluded: "50", whatsappPrice: "0.07" });
    expect(set.status).toBe(200);
    expect((await set.json()).plans.find((p: { venueId: number }) => p.venueId === id)).toMatchObject({ whatsappIncluded: 50, whatsappPrice: 0.07 });
    expect((await post(ownerCookie, { action: "setPlan", venueId: id, monthlyFee: "", billingStartsOn: "", whatsappPrice: "-1" })).status).toBe(400);
    const all = await (await get(ownerCookie)).json();
    expect(all.messageDefaults).toEqual({ included: 300, unitPrice: 0.08 });
  });
});

describe("the customer opening the chat", () => {
  let courtId: number;
  let venueId: number;
  const day = addDays(todayISO(), 4);
  let hour = 10;

  beforeAll(async () => {
    const v = (await listVenues())[0];
    venueId = v.id;
    courtId = v.courts.find((c) => c.capacity === 1)!.id;
  });

  function chatOn() {
    process.env.WHATSAPP_CHAT_NUMBER = "+60 11-2345 6789";
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
  }

  async function bookAndConfirm(phone: string) {
    const made = await createBooking({ courtId, date: day, hours: [hour++], name: "Aisyah", phone });
    if (!made.ok) throw new Error(made.error);
    const m = await enqueue({
      bookingId: made.booking.id,
      venueId,
      kind: "booking_confirmed",
      channel: "whatsapp",
      recipient: phone,
      body: "msg.confirmed",
      vars: { name: "Aisyah", code: made.booking.code, where: "Court 1", when: day, total: "RM20", link: "x" },
    });
    return { booking: made.booking, message: m };
  }

  it("is on only with a number to message and a secret to check Meta with", () => {
    expect(chatNumber()).toBeNull();
    expect(chatRepliesOn()).toBe(false);
    process.env.WHATSAPP_CHAT_NUMBER = "+60 11-2345 6789";
    expect(chatNumber()).toBe("601123456789");
    expect(chatRepliesOn()).toBe(false);
    process.env.WHATSAPP_APP_SECRET = "s";
    expect(chatRepliesOn()).toBe(true);
    expect(chatHoldMinutes()).toBe(3);
    process.env.MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES = "99";
    expect(chatHoldMinutes()).toBe(3);
  });

  it("does not hold confirmations when it is off", async () => {
    const { message } = await bookAndConfirm("0171110001");
    expect(Date.parse(message.nextAttemptAt + "Z")).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("answers in the chat for free, and the paid template is never sent", async () => {
    chatOn();
    const { booking, message } = await bookAndConfirm("0171110002");
    expect(Date.parse(message.nextAttemptAt + "Z")).toBeGreaterThan(Date.now() + 2 * 60_000);
    // Not due yet: nothing goes on its own.
    await drainOutbox();
    expect(sent.find((m) => m.id === message.id)).toBeUndefined();

    const reply = await answerChat("60171110002", `Hi! Please send me booking ${booking.code.toLowerCase()}.`);
    expect(reply).toMatchObject({ answered: true, message: { id: message.id, free: true, status: "sent" } });
    expect(sent.at(-1)).toMatchObject({ id: message.id, free: true });

    // Asked again later: the same words again, still free, as a new message.
    const again = await answerChat("+60 17-111 0002", booking.code);
    expect(again.answered).toBe(true);
    expect(again.message!.id).not.toBe(message.id);
    const all = await messagesForBooking(booking.id);
    expect(all.every((m) => m.free && m.status === "sent")).toBe(true);
    expect((await usageOf(venueId))!.free).toBeGreaterThanOrEqual(2);
  });

  it("tells nobody about a booking that is not theirs", async () => {
    chatOn();
    const { booking } = await bookAndConfirm("0171110003");
    expect(await answerChat("60199999999", booking.code)).toMatchObject({ answered: false });
    expect(await answerChat("60171110003", "hello?")).toMatchObject({ answered: false });
    expect(await answerChat("60171110003", "MS-ZZZZZZ")).toMatchObject({ answered: false });
    expect(await answerChat("not a number", booking.code)).toMatchObject({ answered: false });
  });

  it("falls back to the template when the reply cannot go", async () => {
    chatOn();
    const { booking, message } = await bookAndConfirm("0171110004");
    setTransport({ name: "down", send: async () => { throw new Error("WhatsApp is down"); } });
    expect(await answerChat("60171110004", booking.code)).toMatchObject({ answered: false });
    const back = (await messagesForBooking(booking.id)).find((m) => m.id === message.id)!;
    expect(back).toMatchObject({ free: false, status: "queued", lastError: "WhatsApp is down" });
    // And nothing to resend yet when nothing has been sent.
    const other = await bookAndConfirm("0171110005");
    await getDb().prepare("UPDATE messages SET status = 'abandoned' WHERE id = ?").run(other.message.id);
    expect(await answerChat("60171110005", other.booking.code)).toMatchObject({ answered: false, reason: "nothing to send about it yet" });
  });

  it("is reached through Meta's signed webhook", async () => {
    const mod = await import("../src/app/api/whatsapp/webhook/route");
    const verify = (q: string) => mod.GET(new NextRequest(`http://localhost/api/whatsapp/webhook?${q}`));
    expect((await verify("hub.mode=subscribe&hub.verify_token=x&hub.challenge=42")).status).toBe(403);
    chatOn();
    const ok = await verify("hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(await ok.text()).toBe("42");

    const { booking } = await bookAndConfirm("0171110006");
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [
        { from: "60171110006", type: "text", text: { body: `Please send me ${booking.code}` } },
        { from: "60171110006", type: "image" },
      ] } }] }],
    });
    const sign = (raw: string, secret = "app-secret") => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const post = (raw: string, signature?: string) =>
      mod.POST(new NextRequest("http://localhost/api/whatsapp/webhook", { method: "POST", body: raw, headers: signature ? { "x-hub-signature-256": signature } : {} }));
    expect((await post(body)).status).toBe(401);
    expect((await post(body, sign(body, "wrong"))).status).toBe(401);
    expect((await post("{", sign("{"))).status).toBe(400);
    const res = await post(body, sign(body));
    expect(await res.json()).toEqual({ ok: true, answered: 1 });
    delete process.env.WHATSAPP_APP_SECRET;
    expect((await post(body, sign(body))).status).toBe(404);
  });

  it("offers the button on the confirmation", async () => {
    chatOn();
    const mod = await import("../src/app/api/bookings/route");
    const res = await mod.POST(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.7" },
        body: JSON.stringify({ courtId, date: day, hours: [hour++], name: "Mei", phone: "0171110007" }),
      })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).chatNumber).toBe("601123456789");
  });
});
