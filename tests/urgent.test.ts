import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { notifyPaid, notifyReminders, rememberLocale } from "../src/lib/notify";
import { drainOutbox, messagesForBooking, recordDelivery, setTransport, type OutboxMessage } from "../src/lib/outbox";
import { createBooking, createBookingSeries, createClassSessions, enrolInClass, listVenues } from "../src/lib/store";
import { acknowledge, noticeById, noticeByToken, openNotices } from "../src/lib/urgent";
import { setWhatsappOn, setWhatsappReminders } from "../src/lib/whatsapp-credit";
import { addDays, todayISO } from "../src/lib/time";
import type { Court } from "../src/lib/types";

/** What the venue tells a customer, and knowing that they have it. */

let venueId: number;
let otherVenueId: number;
let courts: Court[];
let ownerCookie: string;
let deskCookie: string;
let outsiderCookie: string;
let hour = 9;
const day = addDays(todayISO(), 5);
const sent: OutboxMessage[] = [];

function req(path: string, method = "GET", body?: unknown, cookie = deskCookie) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-forwarded-for": `10.8.${hour}.1` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function book(over: { email?: string; phone?: string; court?: number; date?: string; hours?: number[] } = {}) {
  const made = await createBooking({
    courtId: over.court ?? courts[0].id,
    date: over.date ?? day,
    hours: over.hours ?? [hour++],
    name: "Nurul Hana",
    phone: over.phone ?? "0161234567",
    email: over.email,
  });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const venues = await listVenues();
  const v = venues.find((x) => x.courts.filter((c) => c.capacity === 1 && c.sport === "badminton").length >= 2)!;
  venueId = v.id;
  courts = v.courts.filter((c) => c.capacity === 1 && c.sport === "badminton");
  otherVenueId = venues.find((x) => x.id !== venueId)!.id;
  const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  const desk = await createAdmin({ name: "Desk", email: "desk@urgent.my", password: "desk-password", venueId });
  const outsider = await createAdmin({ name: "Out", email: "out@urgent.my", password: "desk-password", venueId: otherVenueId });
  if (!desk.ok || !outsider.ok) throw new Error("admins");
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  outsiderCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(outsider.admin.id)).token}`;
});
afterEach(async () => {
  setTransport(null);
  sent.length = 0;
  await setWhatsappOn(venueId, false);
  await setWhatsappReminders(venueId, false);
});

describe("a booking the venue cancels", () => {
  it("tells the customer, in their language, with a link to say they have seen it", async () => {
    const b = await book({ email: "nurul@example.my" });
    await rememberLocale([b.id], "ms");
    const mod = await import("../src/app/api/admin/bookings/cancel/route");
    const res = await mod.POST(req("/api/admin/bookings/cancel", "POST", { code: b.code }));
    expect(res.status).toBe(200);
    const { noticeId } = await res.json();
    const [m] = await messagesForBooking(b.id);
    expect(m).toMatchObject({ kind: "booking_cancelled_by_venue", channel: "email", locale: "ms" });
    expect(m.body).toContain("terpaksa membatalkan tempahan");
    expect(m.body).toContain("Tiada apa-apa yang perlu anda bayar.");
    const token = m.body.match(/\/ack\/([A-Za-z0-9_-]+)/)![1];

    // Waiting while nothing can send it; sent once something does.
    expect((await openNotices([venueId])).find((n) => n.id === noticeId)).toMatchObject({ kind: "cancelled", reach: "waiting", resolvedAt: null });
    setTransport({ name: "test", send: async (x) => void sent.push(x) });
    await drainOutbox();
    expect((await openNotices([venueId])).find((n) => n.id === noticeId)).toMatchObject({ reach: "sent" });
    expect(await noticeByToken(token)).toMatchObject({ ackedAt: null });
    expect(await noticeByToken("bad token!")).toBeNull();

    // The customer taps the link, and then the button on the page.
    const ack = await import("../src/app/api/ack/route");
    expect((await ack.POST(req("/api/ack", "POST", { token: "nope-nope-nope" }))).status).toBe(404);
    expect((await ack.POST(new NextRequest("http://localhost/api/ack", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await ack.POST(req("/api/ack", "POST", { token }))).status).toBe(200);
    expect(await noticeById(noticeId)).toMatchObject({ reach: "acknowledged", resolution: "acknowledged" });
    expect((await openNotices([venueId])).some((n) => n.id === noticeId)).toBe(false);
    expect(await acknowledge("bad token!")).toBe(false);
  });

  it("asks the desk to ring a customer nothing can reach, until they say they have", async () => {
    const b = await book();
    const mod = await import("../src/app/api/admin/bookings/cancel/route");
    const { noticeId } = await (await mod.POST(req("/api/admin/bookings/cancel", "POST", { code: b.code }))).json();
    expect(await messagesForBooking(b.id)).toEqual([]);
    expect(await noticeById(noticeId)).toMatchObject({ reach: "unreachable", phone: "0161234567" });

    const attention = await import("../src/app/api/admin/attention/route");
    const list = await (await attention.GET(req("/api/admin/attention"))).json();
    expect(list.open.map((n: { id: number }) => n.id)).toContain(noticeId);
    expect((await (await attention.GET(req("/api/admin/attention", "GET", undefined, outsiderCookie))).json()).open).toEqual([]);
    expect((await attention.POST(req("/api/admin/attention", "POST", { id: noticeId, action: "told" }, outsiderCookie))).status).toBe(403);
    expect((await attention.POST(req("/api/admin/attention", "POST", { id: noticeId, action: "dance" }))).status).toBe(400);
    expect((await attention.POST(req("/api/admin/attention", "POST", { id: 999999, action: "told" }))).status).toBe(404);
    const told = await (await attention.POST(req("/api/admin/attention", "POST", { id: noticeId, action: "told" }))).json();
    expect(told.open.some((n: { id: number }) => n.id === noticeId)).toBe(false);
    expect(told.recent.find((n: { id: number }) => n.id === noticeId)).toMatchObject({ reach: "told" });
    expect((await attention.POST(req("/api/admin/attention", "POST", { id: noticeId, action: "told" }))).status).toBe(409);
    expect((await attention.POST(new NextRequest("http://localhost/api/admin/attention", { method: "POST", headers: { cookie: deskCookie }, body: "{" }))).status).toBe(400);
  });

  it("follows WhatsApp to the phone: sent, delivered, read — or failed after all", async () => {
    await setWhatsappOn(venueId, true);
    let n = 0;
    setTransport({ name: "test", send: async (m) => (sent.push(m), m.channel === "whatsapp" ? { providerId: `wamid.${++n}` } : undefined) });
    const b = await book({ email: "nurul@example.my", phone: "0177000001" });
    const mod = await import("../src/app/api/admin/bookings/cancel/route");
    const { noticeId } = await (await mod.POST(req("/api/admin/bookings/cancel", "POST", { code: b.code }))).json();
    await drainOutbox();
    const wa = (await messagesForBooking(b.id)).find((m) => m.channel === "whatsapp")!;
    expect(wa.status).toBe("sent");
    expect(await recordDelivery({ id: "wamid.unknown", status: "delivered" })).toBe(false);
    expect(await recordDelivery({ id: `wamid.${n}`, status: "sent" })).toBe(false);
    expect(await recordDelivery({ id: `wamid.${n}`, status: "delivered", timestamp: "1760000000" })).toBe(true);
    expect((await noticeById(noticeId))!.reach).toBe("delivered");
    expect(await recordDelivery({ id: `wamid.${n}`, status: "read" })).toBe(true);
    expect((await noticeById(noticeId))!.reach).toBe("read");
    expect((await messagesForBooking(b.id)).find((m) => m.channel === "whatsapp")!.deliveredAt).toBe("2025-10-09 08:53:20");

    // A message Meta later could not deliver shows its reason.
    const c = await book({ phone: "0177000002" });
    const second = await (await mod.POST(req("/api/admin/bookings/cancel", "POST", { code: c.code }))).json();
    await drainOutbox();
    await recordDelivery({ id: `wamid.${n}`, status: "failed", error: "Not a WhatsApp number" });
    const failed = await noticeById(second.noticeId);
    expect(failed).toMatchObject({ reach: "failed" });
    expect(failed!.messages[0].error).toBe("Not a WhatsApp number");

    // Meta's webhook carries the same reports.
    const { createHmac } = await import("node:crypto");
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    const hook = await import("../src/app/api/whatsapp/webhook/route");
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "read", timestamp: "1760000100" }, { status: "read" }] } }] }] });
    const res = await hook.POST(
      new NextRequest("http://localhost/api/whatsapp/webhook", {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}` },
      })
    );
    expect(await res.json()).toMatchObject({ reports: 1 });
    delete process.env.WHATSAPP_APP_SECRET;
  });
});

describe("other news from the venue", () => {
  it("tells a moved customer where they are now", async () => {
    const b = await book({ email: "nurul@example.my" });
    const mod = await import("../src/app/api/admin/bookings/move/route");
    const res = await mod.POST(req("/api/admin/bookings/move", "POST", { code: b.code, courtId: courts[1].id }));
    expect(res.status).toBe(200);
    const [m] = await messagesForBooking(b.id);
    expect(m.kind).toBe("booking_moved");
    expect(m.body).toContain(courts[1].name);
    expect(m.calendar).toContain("BEGIN:VEVENT");
    expect((await openNotices([venueId])).some((x) => x.bookingId === b.id && x.kind === "moved")).toBe(true);
  });

  it("tells everybody in a class the venue calls off", async () => {
    const made = await createClassSessions({ courtId: courts[1].id, name: "Smash clinic", instructor: "Coach Lee", date: addDays(day, 1), startHour: 10, endHour: 11, capacity: 1, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const enrolled = await enrolInClass({ classId: made.classes[0].id, name: "Mei", phone: "0189990000", email: "mei@example.my" });
    if (!enrolled.ok) throw new Error(enrolled.error);
    const mod = await import("../src/app/api/admin/classes/[id]/route");
    const res = await mod.DELETE(req(`/api/admin/classes/${made.classes[0].id}`, "DELETE"), { params: Promise.resolve({ id: String(made.classes[0].id) }) });
    expect(res.status).toBe(200);
    const [m] = await messagesForBooking(enrolled.booking.id);
    expect(m.kind).toBe("booking_cancelled_by_venue");
    expect(m.body).toContain("Smash clinic");
  });

  it("will not close a day over bookings without saying so, then cancels and tells", async () => {
    const date = addDays(day, 3);
    const b = await book({ email: "nurul@example.my", date, hours: [15] });
    const made = await createClassSessions({ courtId: courts[1].id, name: "Footwork", instructor: "Coach Lee", date, startHour: 9, endHour: 10, capacity: 1, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const mod = await import("../src/app/api/admin/venues/[id]/closures/route");
    const params = { params: Promise.resolve({ id: String(venueId) }) };
    const refused = await mod.POST(req(`/api/admin/venues/${venueId}/closures`, "POST", { date, reason: "Flood" }), params);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ bookings: 1, classes: 1 });
    const done = await mod.POST(req(`/api/admin/venues/${venueId}/closures`, "POST", { date, reason: "Flood", cancelAffected: true }), params);
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({ cancelled: 2 });
    expect((await messagesForBooking(b.id))[0].kind).toBe("booking_cancelled_by_venue");
    // A day with nothing on it closes straight away.
    expect((await mod.POST(req(`/api/admin/venues/${venueId}/closures`, "POST", { date: addDays(day, 20) }), params)).status).toBe(201);
  });
});

describe("the day before", () => {
  it("reminds anyone who booked well ahead, once, by email — and on WhatsApp where the venue chose it", async () => {
    const date = addDays(todayISO(), 1);
    const ahead = await book({ email: "nurul@example.my", date, hours: [20] });
    const lastMinute = await book({ email: "late@example.my", date, hours: [21] });
    const phoneOnly = await book({ date, hours: [22], phone: "0170000003" });
    await getDb().prepare("UPDATE bookings SET created_at = datetime('now', '-3 days') WHERE id IN (?, ?)").run(ahead.id, phoneOnly.id);
    const [y, m, d] = date.split("-").map(Number);
    // Booked two hours before it starts: no reminder needed.
    const late = new Date(Date.UTC(y, m - 1, d, 21 - 8) - 2 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
    await getDb().prepare("UPDATE bookings SET created_at = ? WHERE id = ?").run(late, lastMinute.id);
    const at = new Date(Date.UTC(y, m - 1, d, 20 - 8) - 10 * 3_600_000);
    await setWhatsappOn(venueId, true);

    // WhatsApp reminders off: email only, and nothing for the phone-only customer.
    expect(await notifyReminders(at)).toBe(1);
    expect((await messagesForBooking(ahead.id)).map((x) => [x.kind, x.channel])).toEqual([["booking_reminder", "email"]]);
    expect(await messagesForBooking(lastMinute.id)).toEqual([]);
    expect(await notifyReminders(at)).toBe(0);

    await setWhatsappReminders(venueId, true);
    expect(await notifyReminders(at)).toBe(1);
    expect((await messagesForBooking(phoneOnly.id)).map((x) => [x.kind, x.channel])).toEqual([["booking_reminder", "whatsapp"]]);
    // Too early: more than a day out.
    expect(await notifyReminders(new Date(at.getTime() - 48 * 3_600_000))).toBe(0);
  });
});

describe("a receipt", () => {
  it("goes by email when a booking is paid at the counter, and only once", async () => {
    const b = await book({ email: "nurul@example.my" });
    const mod = await import("../src/app/api/admin/payments/route");
    expect((await mod.POST(req("/api/admin/payments", "POST", { code: b.code, paid: true }))).status).toBe(200);
    const receipts = (await messagesForBooking(b.id)).filter((m) => m.kind === "payment_received");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ channel: "email" });
    expect(receipts[0].body).toContain("paid at the counter");
    await notifyPaid([{ ...b, paymentStatus: "paid" }], "online");
    expect((await messagesForBooking(b.id)).filter((m) => m.kind === "payment_received")).toHaveLength(1);

    // No email, no receipt; and never on WhatsApp.
    await setWhatsappOn(venueId, true);
    const c = await book();
    await mod.POST(req("/api/admin/payments", "POST", { code: c.code, paid: true }));
    expect(await messagesForBooking(c.id)).toEqual([]);
  });

  it("covers every week of a series paid at once", async () => {
    const made = await createBookingSeries({ courtId: courts[0].id, date: addDays(day, 7), hours: [10], weeks: 2, name: "Raj", phone: "0172223333", email: "raj@example.my" });
    if (!made.ok) throw new Error(made.error);
    const mod = await import("../src/app/api/admin/payments/route");
    expect((await mod.POST(req("/api/admin/payments", "POST", { seriesCode: made.seriesCode }))).status).toBe(200);
    for (const b of made.bookings)
      expect((await messagesForBooking(b.id)).filter((m) => m.kind === "payment_received")).toHaveLength(1);
  });
});
