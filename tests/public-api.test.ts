import dns from "dns";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createApiKey, revokeApiKey } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import { availabilityFeed, merchantFeed, serviceFeed, setGoogleReserve } from "../src/lib/google-feeds";
import { adminCancelBooking, createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { addEndpoint, deliverWebhooks, isPrivate, listEndpoints, signature, sweepWebhookEvents } from "../src/lib/webhooks";
import { GET as venueGet } from "../src/app/api/v1/venue/route";
import { GET as availabilityGet } from "../src/app/api/v1/availability/route";
import { GET as bookingsGet, POST as bookingsPost } from "../src/app/api/v1/bookings/route";
import { GET as bookingGet } from "../src/app/api/v1/bookings/[code]/route";
import { POST as cancelPost } from "../src/app/api/v1/bookings/[code]/cancel/route";

/**
 * A venue's own systems: the public API with its keys, webhooks signed and
 * retried, and the draft Reserve with Google feeds.
 */

let venueId: number;
let otherVenueId: number;
let courtId: number;
let otherCourtId: number;
let readKey: string;
let writeKey: string;
const day = addDays(todayISO(), 3);

const call = (url: string, key: string | null, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const params = (code: string) => ({ params: Promise.resolve({ code }) });

beforeAll(async () => {
  const made = await createVenue({ name: "API Arena", area: "PJ", address: "1 Jalan API", phone: "0388880000" });
  const other = await createVenue({ name: "Other Arena", area: "PJ", address: "x", phone: "0388880001" });
  if (!made.ok || !other.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenueId = other.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  const o = await createCourt({ venueId: otherVenueId, name: "C", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!c.ok || !o.ok) throw new Error("court");
  courtId = c.court.id;
  otherCourtId = o.court.id;
  const r = await createApiKey(venueId, { name: "Desk screen", scope: "read" }, null);
  const w = await createApiKey(venueId, { name: "Website", scope: "write" }, null);
  if (!r.ok || !w.ok) throw new Error("keys");
  readKey = r.key;
  writeKey = w.key;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the public API", () => {
  it("needs a valid key, kept only as a hash", async () => {
    expect((await venueGet(call("/api/v1/venue", null))).status).toBe(401);
    expect((await venueGet(call("/api/v1/venue", "ms_r_notarealkeynotarealkey12345"))).status).toBe(401);
    const stored = (await getDb().prepare("SELECT key_hash FROM venue_api_keys WHERE venue_id = ?").all(venueId)) as { key_hash: string }[];
    expect(JSON.stringify(stored)).not.toContain(readKey);
    const res = await venueGet(call("/api/v1/venue", readKey));
    expect(res.status).toBe(200);
    expect((await res.json()).venue).toMatchObject({ id: venueId, name: "API Arena", courts: [{ id: courtId, sport: "badminton" }] });
  });

  it("reads availability and bookings, a month at most", async () => {
    const av = await (await availabilityGet(call(`/api/v1/availability?date=${day}`, readKey))).json();
    expect(av.courts[0].slots.some((s: { available: boolean }) => s.available)).toBe(true);
    expect((await bookingsGet(call(`/api/v1/bookings?from=${day}&to=${addDays(day, 40)}`, readKey))).status).toBe(400);
  });

  it("books and cancels with a write key only, at its own venue only", async () => {
    const body = { courtId, date: day, hours: [9], name: "Web Customer", phone: "0123334455", email: "web@example.my" };
    expect((await bookingsPost(call("/api/v1/bookings", readKey, { method: "POST", body }))).status).toBe(403);
    expect((await bookingsPost(call("/api/v1/bookings", writeKey, { method: "POST", body: { ...body, courtId: otherCourtId } }))).status).toBe(404);
    const res = await bookingsPost(call("/api/v1/bookings", writeKey, { method: "POST", body }));
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    expect(booking).toMatchObject({ status: "confirmed", courtName: "Court 1", name: "Web Customer" });
    expect([20, 30]).toContain(booking.totalPrice); // off-peak or weekend
    const listed = await (await bookingsGet(call(`/api/v1/bookings?from=${day}&to=${day}`, readKey))).json();
    expect(listed.bookings.map((b: { code: string }) => b.code)).toContain(booking.code);
    const elsewhere = await createBooking({ courtId: otherCourtId, date: day, hours: [9], name: "X", phone: "0123334466" });
    if (!elsewhere.ok) throw new Error(elsewhere.error);
    expect((await bookingGet(call(`/api/v1/bookings/${elsewhere.booking.code}`, readKey), params(elsewhere.booking.code))).status).toBe(404);
    const cancelled = await cancelPost(call(`/api/v1/bookings/${booking.code}/cancel`, writeKey, { method: "POST" }), params(booking.code));
    expect((await cancelled.json()).booking.status).toBe("cancelled");
  });

  it("with an availability key, shows availability and the venue but no customer", async () => {
    const a = await createApiKey(venueId, { name: "Widget", scope: "availability" }, null);
    if (!a.ok) throw new Error(a.error);
    expect(a.key.startsWith("ms_a_")).toBe(true);
    expect((await venueGet(call("/api/v1/venue", a.key))).status).toBe(200);
    expect((await availabilityGet(call(`/api/v1/availability?date=${day}`, a.key))).status).toBe(200);
    expect((await bookingsGet(call(`/api/v1/bookings?from=${day}&to=${day}`, a.key))).status).toBe(403);
  });

  it("stops at once for a revoked key", async () => {
    const k = await createApiKey(venueId, { name: "Old", scope: "read" }, null);
    if (!k.ok) throw new Error(k.error);
    expect(await revokeApiKey(k.record.id, venueId)).toBe(true);
    expect((await venueGet(call("/api/v1/venue", k.key))).status).toBe(401);
  });
});

describe("webhooks", () => {
  it("go only to public HTTPS addresses", async () => {
    expect(await addEndpoint(venueId, "http://hooks.example.com/x")).toMatchObject({ ok: false });
    expect(await addEndpoint(venueId, "https://localhost/x")).toMatchObject({ ok: false });
    expect(await addEndpoint(venueId, "https://10.0.0.5/x")).toMatchObject({ ok: false });
    expect(isPrivate("192.168.1.1")).toBe(true);
    expect(isPrivate("169.254.169.254")).toBe(true);
    expect(isPrivate("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivate("fd00::1")).toBe(true);
    expect(isPrivate("8.8.8.8")).toBe(false);
    // The same addresses written other ways.
    expect(isPrivate("::ffff:7f00:1")).toBe(true);
    expect(isPrivate("64:ff9b::10.0.0.1")).toBe(true);
    expect(isPrivate("::127.0.0.1")).toBe(true);
    expect(isPrivate("198.18.0.1")).toBe(true);
    expect(isPrivate("::ffff:808:808")).toBe(false);
  });

  it("tell of bookings made, paid, moved and cancelled, signed, once each", async () => {
    const added = await addEndpoint(venueId, "https://hooks.example.com/mysenam");
    if (!added.ok) throw new Error(added.error);
    // Bookings from before the address was added are noted, not sent.
    await sweepWebhookEvents();
    await getDb().prepare("DELETE FROM webhook_deliveries").run();
    const made = await createBooking({ courtId, date: day, hours: [14], name: "Hook Tan", phone: "0123337777" });
    if (!made.ok) throw new Error(made.error);
    await sweepWebhookEvents();
    await setPaymentStatus(made.booking.code, true, "cash");
    await sweepWebhookEvents();
    await getDb().prepare("UPDATE bookings SET start_hour = 15, end_hour = 16 WHERE id = ?").run(made.booking.id);
    await sweepWebhookEvents();
    await adminCancelBooking(made.booking.code);
    await sweepWebhookEvents();
    await sweepWebhookEvents();
    const events = (await getDb().prepare("SELECT event FROM webhook_deliveries ORDER BY id").all()) as { event: string }[];
    expect(events.map((e) => e.event)).toEqual(["booking.created", "booking.paid", "booking.changed", "booking.cancelled"]);

    const received: { body: string; sig: string }[] = [];
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
        received.push({ body: init.body, sig: init.headers["MySenam-Signature"] });
        return new Response("ok", { status: 200 });
      })
    );
    expect(await deliverWebhooks()).toEqual({ sent: 4, failed: 0 });
    const first = received[0];
    const at = Number(first.sig.match(/t=(\d+)/)![1]);
    expect(first.sig).toBe(signature(added.secret, first.body, at));
    expect(JSON.parse(first.body)).toMatchObject({ type: "booking.created", data: { booking: { code: made.booking.code, name: "Hook Tan" } } });
    expect(await deliverWebhooks()).toEqual({ sent: 0, failed: 0 });
  });

  it("are retried later when the receiver fails, and an address failing for a day is turned off", async () => {
    const [endpoint] = await listEndpoints(venueId);
    await getDb().prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES (?, 'ping', '{}')").run(endpoint.id);
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const now = new Date();
    expect(await deliverWebhooks(now)).toEqual({ sent: 0, failed: 1 });
    expect(await deliverWebhooks(now)).toEqual({ sent: 0, failed: 0 });
    const later = new Date(now.getTime() + 25 * 3_600_000);
    expect(await deliverWebhooks(later)).toEqual({ sent: 0, failed: 1 });
    expect((await listEndpoints(venueId))[0]).toMatchObject({ active: false });
  });

  it("refuse an address that resolves somewhere private", async () => {
    const added = await addEndpoint(otherVenueId, "https://sneaky.example.com/x");
    if (!added.ok) throw new Error(added.error);
    await getDb().prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES (?, 'ping', '{}')").run(added.endpoint.id);
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await deliverWebhooks();
    expect(fetch).not.toHaveBeenCalled();
    expect((await listEndpoints(otherVenueId))[0].recent[0].error).toContain("public internet");
  });
});

describe("Reserve with Google feeds", () => {
  it("list only venues that opted in and are live", async () => {
    expect(((await merchantFeed()).merchant as unknown[]).length).toBe(0);
    await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
    await setGoogleReserve(venueId, true);
    const merchants = (await merchantFeed()).merchant as { merchant_id: string; name: string }[];
    expect(merchants).toEqual([expect.objectContaining({ merchant_id: `venue-${venueId}`, name: "API Arena" })]);
    const services = (await serviceFeed()).service as { service_id: string; price: { price_micros: number } }[];
    expect(services[0]).toMatchObject({ service_id: `venue-${venueId}-badminton-60`, price: { price_micros: 20_000_000 } });
    const feed = (await availabilityFeed(2)) as { service_availability: { availability: { spots_total: number; spots_open: number; start_sec: number }[] }[] };
    const slots = feed.service_availability[0].availability;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.spots_total === 1 && s.spots_open <= 1 && Number.isInteger(s.start_sec))).toBe(true);
  });
});
