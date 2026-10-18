import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
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
import { notifyBookingConfirmed } from "../src/lib/notify";
import { createBooking, createVenue, listVenues } from "../src/lib/store";
import { answerChat } from "../src/lib/whatsapp-chat";
import {
  LOW_CREDIT,
  chatOfferedFor,
  creditBalance,
  grantCredit,
  listPacks,
  orderPack,
  packPrice,
  packSize,
  payPackOnline,
  setWhatsappOn,
  settlePack,
  spendCredit,
  voidPack,
  whatsappReady,
} from "../src/lib/whatsapp-credit";
import { monthBounds, monthOf, usageFor, usageOf } from "../src/lib/whatsapp-usage";
import { settleBill } from "../src/lib/payments";
import { addDays, todayISO } from "../src/lib/time";

/** WhatsApp only where a venue wants it, paid for before it is sent. */

const ENV = [
  "MYSENAM_MARKETPLACE",
  "MYSENAM_WHATSAPP_PACK",
  "MYSENAM_WHATSAPP_PACK_PRICE",
  "WHATSAPP_CHAT_NUMBER",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES",
  "BILLPLZ_API_KEY",
  "BILLPLZ_COLLECTION_ID",
  "BILLPLZ_X_SIGNATURE_KEY",
];
let n = 0;
const sent: OutboxMessage[] = [];
let ownerId: number;

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

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!.id;
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.MYSENAM_MARKETPLACE = "on";
  sent.length = 0;
  setTransport({ name: "test", send: async (m) => void sent.push(m) });
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  setTransport(null);
  vi.unstubAllGlobals();
});

describe("months", () => {
  it("are Malaysia's, counted in UTC", () => {
    expect(monthOf(new Date("2026-10-31T16:30:00Z"))).toBe("2026-11");
    expect(monthBounds("2026-10")).toEqual(["2026-09-30 16:00:00", "2026-10-31 16:00:00"]);
    expect(monthBounds("2026-12")).toEqual(["2026-11-30 16:00:00", "2026-12-31 16:00:00"]);
  });

  it("count templates and chat replies apart, and nothing unsent", async () => {
    const id = await venue();
    await sentAt(id, "2026-09-30 16:00:00", 4);
    await sentAt(id, "2026-09-30 15:59:59", 5);
    await sentAt(id, "2026-10-10 10:00:00", 2, 1);
    await getDb()
      .prepare("INSERT INTO messages (venue_id, kind, channel, recipient, body, status) VALUES (?, 'booking_confirmed', 'whatsapp', '0123', 'Hi', 'failed')")
      .run(id);
    expect(await usageOf(id, "2026-10")).toEqual({ venueId: id, month: "2026-10", paid: 4, free: 2 });
    expect((await usageOf(id, "2026-09")).paid).toBe(5);
    expect(await usageFor("2026-10", [])).toEqual(new Map());
    expect((await usageFor("2026-10")).get(id)!.paid).toBe(4);
  });
});

describe("credit", () => {
  it("is off and empty to begin with, and WhatsApp needs both", async () => {
    const id = await venue();
    expect(await creditBalance(id)).toBe(0);
    expect(await whatsappReady(id)).toBe(false);
    await setWhatsappOn(id, true);
    expect(await whatsappReady(id)).toBe(false); // no credit on a marketplace
    await grantCredit(id, 3, ownerId);
    expect(await whatsappReady(id)).toBe(true);
    // A venue's own install pays Meta itself: switched on is enough.
    delete process.env.MYSENAM_MARKETPLACE;
    const own = await venue();
    await setWhatsappOn(own, true);
    expect(await whatsappReady(own)).toBe(true);
    expect(await spendCredit(own, null)).toBe(true);
    expect(await creditBalance(own)).toBe(0);
  });

  it("is spent one message at a time, never below zero", async () => {
    const id = await venue();
    await grantCredit(id, 2, ownerId);
    expect(await spendCredit(id, null)).toBe(true);
    expect(await spendCredit(id, null)).toBe(true);
    expect(await spendCredit(id, null)).toBe(false);
    expect(await creditBalance(id)).toBe(0);
    expect(await grantCredit(id, 0, ownerId)).toMatchObject({ ok: false });
    expect(await grantCredit(id, -1, ownerId)).toMatchObject({ ok: false });
    expect(await grantCredit(id, 1.5, ownerId)).toMatchObject({ ok: false });
  });

  it("stops WhatsApp at zero, and the venue's staff are told", async () => {
    const id = await venue();
    const desk = await createAdmin({ name: "Desk", email: `low${id}@chat.my`, password: "desk-password", venueId: id });
    if (!desk.ok) throw new Error(desk.error);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.MYSENAM_SEND = "log";
    await grantCredit(id, LOW_CREDIT + 1, ownerId);
    await spendCredit(id, null);
    expect(log.mock.calls.some((c) => String(c[0]).includes(`${LOW_CREDIT} WhatsApp messages left`))).toBe(true);
    await grantCredit(id, -LOW_CREDIT + 1, ownerId);
    await spendCredit(id, null);
    expect(log.mock.calls.some((c) => String(c[0]).includes("WhatsApp credit used up"))).toBe(true);
    delete process.env.MYSENAM_SEND;
    log.mockRestore();
  });

  it("is checked when a WhatsApp message is about to go, and given back if it cannot", async () => {
    const v = (await listVenues())[0];
    await setWhatsappOn(v.id, true);
    await grantCredit(v.id, 1, ownerId);
    const court = v.courts.find((c) => c.capacity === 1)!;
    const book = async (hour: number) => {
      const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 9), hours: [hour], name: "Aisyah", phone: "0171230000" });
      if (!made.ok) throw new Error(made.error);
      await notifyBookingConfirmed([made.booking], "en", null);
      return made.booking;
    };
    const first = await book(10);
    // Credit was there when it was written; it goes, and spends it.
    await drainOutbox();
    expect((await messagesForBooking(first.id))[0].status).toBe("sent");
    expect(await creditBalance(v.id)).toBe(0);

    // None left: nothing is written for a phone-only customer at all...
    const second = await book(11);
    expect(await messagesForBooking(second.id)).toEqual([]);

    // ...and a message written while there was credit, which then ran out, does not go.
    await grantCredit(v.id, 1, ownerId);
    const third = await book(12);
    await spendCredit(v.id, null);
    await drainOutbox();
    expect((await messagesForBooking(third.id))[0]).toMatchObject({ status: "abandoned", lastError: expect.stringContaining("no WhatsApp credit") });

    // A send that fails gives its message back.
    await grantCredit(v.id, 1, ownerId);
    const fourth = await book(13);
    setTransport({ name: "down", send: async () => { throw new Error("down"); } });
    await drainOutbox();
    expect(await creditBalance(v.id)).toBe(1);
    expect((await messagesForBooking(fourth.id))[0].status).toBe("failed");
    await setWhatsappOn(v.id, false);
  });
});

describe("packs", () => {
  it("are ordered at today's price, one unpaid at a time, and credited once paid", async () => {
    process.env.MYSENAM_WHATSAPP_PACK = "500";
    process.env.MYSENAM_WHATSAPP_PACK_PRICE = "45";
    expect([packSize(), packPrice()]).toEqual([500, 45]);
    const id = await venue();
    const pack = await orderPack(id, null);
    expect(pack).toMatchObject({ messages: 500, amount: 45, status: "due" });
    expect((await orderPack(id, null)).id).toBe(pack.id);
    expect(await creditBalance(id)).toBe(0);
    expect(await settlePack(pack.id, "manual", ownerId)).toBe(true);
    expect(await settlePack(pack.id, "manual", ownerId)).toBe(false);
    expect(await creditBalance(id)).toBe(500);
    const next = await orderPack(id, null);
    expect(await voidPack(next.id)).toBe(true);
    expect(await voidPack(next.id)).toBe(false);
    expect((await listPacks(id)).map((p) => p.status)).toEqual(["void", "paid"]);
    process.env.MYSENAM_WHATSAPP_PACK = "nope";
    process.env.MYSENAM_WHATSAPP_PACK_PRICE = "-5";
    expect([packSize(), packPrice()]).toEqual([200, 20]);
  });

  it("are paid online into the platform's account, and credited by the gateway's word", async () => {
    const id = await venue();
    const pack = await orderPack(id, null);
    expect(await payPackOnline(pack.id, { name: "Owner", email: "o@x.my" })).toMatchObject({ ok: false, status: 409 });
    expect(await payPackOnline(999999, { name: "Owner", email: "o@x.my" })).toMatchObject({ ok: false, status: 404 });
    process.env.BILLPLZ_API_KEY = "k";
    process.env.BILLPLZ_COLLECTION_ID = "c";
    process.env.BILLPLZ_X_SIGNATURE_KEY = "x";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `bill-pack-${pack.id}`, url: "https://billplz.example/pack" })));
    const paid = await payPackOnline(pack.id, { name: "Owner", email: "o@x.my" });
    expect(paid).toEqual({ ok: true, url: "https://billplz.example/pack" });
    // Asked again: the same page, not a second bill.
    expect(await payPackOnline(pack.id, { name: "Owner", email: "o@x.my" })).toEqual(paid);
    await settleBill({ billId: `bill-pack-${pack.id}`, paid: true } as never);
    expect(await creditBalance(id)).toBe(200);
    await settleBill({ billId: `bill-pack-${pack.id}`, paid: true } as never);
    expect(await creditBalance(id)).toBe(200);
    expect(await payPackOnline(pack.id, { name: "Owner", email: "o@x.my" })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the WhatsApp settings route", () => {
  it("lets staff switch it on and buy, and only the owner give or mark paid", async () => {
    const id = await venue();
    const other = await venue();
    const desk = await createAdmin({ name: "Desk", email: `desk${id}@chat.my`, password: "desk-password", venueId: id });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const mod = await import("../src/app/api/admin/whatsapp/route");
    const get = (cookie: string, q: string) => mod.GET(new NextRequest(`http://localhost/api/admin/whatsapp?${q}`, { headers: { cookie } }));
    const post = (cookie: string, body: object) =>
      mod.POST(new NextRequest("http://localhost/api/admin/whatsapp", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

    expect((await get(deskCookie, `venueId=${other}`)).status).toBe(403);
    expect((await get(deskCookie, "venueId=x")).status).toBe(400);
    expect(await (await get(deskCookie, `venueId=${id}`)).json()).toMatchObject({ on: false, prepaid: true, balance: 0, pack: { messages: 200, price: 20 } });
    expect(await (await post(deskCookie, { venueId: id, action: "on" })).json()).toMatchObject({ on: true });
    const bought = await (await post(deskCookie, { venueId: id, action: "buy" })).json();
    expect(bought.ordered).toMatchObject({ status: "due" });
    expect((await post(deskCookie, { venueId: id, action: "grant", messages: 50 })).status).toBe(403);
    expect((await post(deskCookie, { venueId: id, action: "markPaid", packId: bought.ordered.id })).status).toBe(403);
    expect((await post(deskCookie, { venueId: id, action: "pay", packId: bought.ordered.id })).status).toBe(409);
    expect((await post(deskCookie, { venueId: id, action: "pay", packId: 999999 })).status).toBe(404);
    expect((await post(deskCookie, { venueId: id, action: "dance" })).status).toBe(403);

    expect(await (await post(ownerCookie, { venueId: id, action: "markPaid", packId: bought.ordered.id })).json()).toMatchObject({ balance: 200 });
    expect((await post(ownerCookie, { venueId: id, action: "markPaid", packId: bought.ordered.id })).status).toBe(409);
    expect((await post(ownerCookie, { venueId: id, action: "void", packId: 999999 })).status).toBe(404);
    expect(await (await post(ownerCookie, { venueId: id, action: "grant", messages: 50 })).json()).toMatchObject({ balance: 250 });
    expect((await post(ownerCookie, { venueId: id, action: "grant", messages: 0 })).status).toBe(400);
    expect((await post(ownerCookie, { venueId: id, action: "dance" })).status).toBe(400);
    expect(await (await post(deskCookie, { venueId: id, action: "off" })).json()).toMatchObject({ on: false });
    expect((await post(deskCookie, { action: "on" })).status).toBe(400);
    expect((await mod.POST(new NextRequest("http://localhost/api/admin/whatsapp", { method: "POST", headers: { cookie: deskCookie }, body: "{" }))).status).toBe(400);

    delete process.env.MYSENAM_MARKETPLACE;
    expect((await post(deskCookie, { venueId: id, action: "buy" })).status).toBe(400);
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
  afterEach(async () => await setWhatsappOn(venueId, false));

  async function chatOn() {
    process.env.WHATSAPP_CHAT_NUMBER = "+60 11-2345 6789";
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
    await setWhatsappOn(venueId, true);
    if ((await creditBalance(venueId)) < 20) await grantCredit(venueId, 50, ownerId);
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

  it("is on only with a number to message and a secret to check Meta with", async () => {
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
    // And offered for a venue only when it sends WhatsApp and has credit.
    expect(await chatOfferedFor(venueId)).toBe(false);
    await setWhatsappOn(venueId, true);
    await grantCredit(venueId, 5, ownerId);
    expect(await chatOfferedFor(venueId)).toBe(true);
  });

  it("does not hold confirmations when it is off", async () => {
    await setWhatsappOn(venueId, false);
    const { message } = await bookAndConfirm("0171110001");
    expect(Date.parse(message.nextAttemptAt + "Z")).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("answers in the chat for free, and the paid template is never sent", async () => {
    await chatOn();
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
    expect((await usageOf(venueId)).free).toBeGreaterThanOrEqual(2);
  });

  it("pays for each reply from the venue's credit, and stops when it is gone", async () => {
    await chatOn();
    const { booking } = await bookAndConfirm("0171110008");
    const before = await creditBalance(venueId);
    expect((await answerChat("60171110008", booking.code)).answered).toBe(true);
    expect(await creditBalance(venueId)).toBe(before - 1);
    await grantCredit(venueId, -(before - 1), ownerId);
    expect(await answerChat("60171110008", booking.code)).toMatchObject({ answered: false, reason: "no WhatsApp credit" });
    const other = await bookAndConfirm("0171110009");
    expect(await answerChat("60171110009", other.booking.code)).toMatchObject({ answered: false, reason: "no WhatsApp credit" });
    // Left for the template, which finds no credit either.
    expect((await messagesForBooking(other.booking.id))[0]).toMatchObject({ free: false, status: "queued" });
  });

  it("tells nobody about a booking that is not theirs", async () => {
    await chatOn();
    const { booking } = await bookAndConfirm("0171110003");
    expect(await answerChat("60199999999", booking.code)).toMatchObject({ answered: false });
    expect(await answerChat("60171110003", "hello?")).toMatchObject({ answered: false });
    expect(await answerChat("60171110003", "MS-ZZZZZZ")).toMatchObject({ answered: false });
    expect(await answerChat("not a number", booking.code)).toMatchObject({ answered: false });
  });

  it("falls back to the template when the reply cannot go", async () => {
    await chatOn();
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
    await chatOn();
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
    await chatOn();
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
