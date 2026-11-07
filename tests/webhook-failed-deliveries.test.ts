import dns from "dns";
import fs from "fs";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { pruneOldData, RETENTION } from "../src/lib/privacy";
import { createVenue } from "../src/lib/store";
import { addEndpoint, deliverWebhooks, listEndpoints, MAX_ATTEMPTS, redeliverFailed, transport } from "../src/lib/webhooks";
import { GET as integrationsGet, POST as integrationsPost } from "../src/app/api/admin/integrations/route";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Hardening round G17 (ADR 0066, migration 0321): a webhook delivery that used all its attempts stays visible with its last
 * status, error and time, can be sent again by a manager of its venue only (same payload, so the same event id; audited; once
 * however many presses), and is removed by retention. The receiver is a stand-in: this proves what MySenam sends and records,
 * never that any receiver processed it.
 */
let venueId: number;
let otherVenueId: number;
let managerCookie: string;
let otherManagerCookie: string;
let deskCookie: string;
let endpointId: number;
const EVENT = (n: number) => JSON.stringify({ id: `evt_test${n}`, type: "booking.created", created: "2026-11-01T00:00:00Z", data: { booking: { code: `B${n}`, name: "Someone Private" } } });

const post = (cookie: string, body: unknown) =>
  new NextRequest("http://localhost/api/admin/integrations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-forwarded-for": "192.0.2.9" },
    body: JSON.stringify(body),
  });

/** A delivery the receiver kept refusing: tried `MAX_ATTEMPTS` times, a back-off apart. */
async function exhausted(n: number, endpoint = endpointId): Promise<number> {
  const row = (await getDb().prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES (?, 'booking.created', ?) RETURNING id").get(endpoint, EVENT(n))) as { id: number };
  const start = new Date("2026-11-01T00:00:00Z");
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await getDb().prepare("UPDATE webhook_deliveries SET next_at = '2000-01-01 00:00:00' WHERE id = ?").run(row.id);
    await deliverWebhooks(new Date(start.getTime() + i * 60_000));
  }
  return row.id;
}

beforeAll(async () => {
  const a = await createVenue({ name: "Hook Arena", area: "PJ", address: "1", phone: "0388880000" });
  const b = await createVenue({ name: "Other Hook Arena", area: "PJ", address: "2", phone: "0388880001" });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueId = a.venue.id;
  otherVenueId = b.venue.id;
  const m = await createAdmin({ name: "Maya Manager", email: "hook-mgr@hook.test", password: "a long enough password", venueId, role: "manager" });
  const o = await createAdmin({ name: "Olly Other", email: "hook-other@hook.test", password: "a long enough password", venueId: otherVenueId, role: "manager" });
  const d = await createAdmin({ name: "Dan Desk", email: "hook-desk@hook.test", password: "a long enough password", venueId, role: "desk" });
  if (!m.ok || !o.ok || !d.ok) throw new Error("admins");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  otherManagerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(o.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
  const e = await addEndpoint(venueId, "https://receiver.example.com/hook");
  if (!e.ok) throw new Error(e.error);
  endpointId = e.endpoint.id;
});

afterEach(() => vi.restoreAllMocks());

function receiverFailing(status = 500) {
  vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  return vi.spyOn(transport, "post").mockResolvedValue(status);
}

describe("a delivery that used all its attempts", () => {
  it("is listed with its address: attempts, last status, last error, last attempt, event id and no payload", async () => {
    receiverFailing(500);
    const id = await exhausted(1);
    const [e] = await listEndpoints(venueId);
    expect(e.failedCount).toBe(1);
    expect(e.failed).toEqual([
      {
        id,
        event: "booking.created",
        eventId: "evt_test1",
        attempts: MAX_ATTEMPTS,
        lastStatus: 500,
        lastError: "Answered 500",
        lastAttemptAt: "2026-11-01 00:07:00",
        createdAt: expect.any(String),
        redeliveries: 0,
        redeliveredAt: null,
      },
    ]);
    // What staff see never carries the booking's payload (it names the customer).
    expect(JSON.stringify(e.failed)).not.toContain("Someone Private");
    // And nothing sends it again by itself.
    vi.restoreAllMocks();
    const send = receiverFailing(200);
    expect(await deliverWebhooks(new Date("2026-11-03T00:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("is sent again by a manager with the same payload and event id, counted, and not listed once delivered", async () => {
    const [before] = await listEndpoints(venueId);
    const failedId = before.failed[0].id;
    const sent: string[] = [];
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.spyOn(transport, "post").mockImplementation(async (_u, _h, body) => {
      sent.push(body);
      return 200;
    });
    const res = await integrationsPost(post(managerCookie, { venueId, action: "redeliver", deliveryId: failedId }));
    expect(res.status).toBe(200);
    expect((await res.json()).requeued).toBe(1);
    expect(await deliverWebhooks()).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([EVENT(1)]);
    expect(JSON.parse(sent[0]).id).toBe("evt_test1");
    const row = (await getDb().prepare("SELECT delivered_at, redeliveries, redelivered_at, attempts FROM webhook_deliveries WHERE id = ?").get(failedId)) as {
      delivered_at: string | null;
      redeliveries: number;
      redelivered_at: string | null;
      attempts: number;
    };
    expect(row.delivered_at).not.toBeNull();
    expect(row.redeliveries).toBe(1);
    expect(row.redelivered_at).not.toBeNull();
    expect((await listEndpoints(venueId))[0].failedCount).toBe(0);
    // Audited, with who.
    const logged = (await getDb().prepare("SELECT admin_name, detail FROM staff_actions WHERE venue_id = ? AND action = 'integration.changed' AND detail LIKE 'Webhook events sent again%'").all(venueId)) as {
      admin_name: string;
      detail: string;
    }[];
    expect(logged).toEqual([{ admin_name: "Maya Manager", detail: `Webhook events sent again: delivery ${failedId}, 1 queued` }]);
  });

  it("pressed twice, or by two managers at once, is sent again once, with the same event id", async () => {
    receiverFailing(500);
    const id = await exhausted(2);
    const results = await Promise.all([redeliverFailed(venueId, { deliveryId: id }), redeliverFailed(venueId, { deliveryId: id }), redeliverFailed(venueId, { endpointId })]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.reduce((n, r) => n + (r.ok ? r.requeued : 0), 0)).toBe(1);
    expect(await redeliverFailed(venueId, { deliveryId: id })).toEqual({ ok: true, requeued: 0 });
    const row = (await getDb().prepare("SELECT redeliveries, attempts, payload FROM webhook_deliveries WHERE id = ?").get(id)) as { redeliveries: number; attempts: number; payload: string };
    expect(row).toMatchObject({ redeliveries: 1, attempts: 0, payload: EVENT(2) });
    // Delivered meanwhile or already delivered: nothing more to send.
    vi.restoreAllMocks();
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.spyOn(transport, "post").mockResolvedValue(200);
    await deliverWebhooks();
    expect(await redeliverFailed(venueId, { deliveryId: id })).toEqual({ ok: true, requeued: 0 });
  });

  it("an address's failed deliveries are sent again together, at most 50, oldest first", async () => {
    receiverFailing(500);
    for (let n = 10; n < 13; n++) await exhausted(n);
    expect((await listEndpoints(venueId))[0].failedCount).toBe(3);
    expect(await redeliverFailed(venueId, { endpointId })).toEqual({ ok: true, requeued: 3 });
    // Fifty-three failed, one request: fifty.
    await getDb().prepare("UPDATE webhook_deliveries SET attempts = ?, delivered_at = NULL, last_status = 500 WHERE endpoint_id = ?").run(MAX_ATTEMPTS, endpointId);
    for (let n = 0; n < 50; n++)
      await getDb().prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload, attempts) VALUES (?, 'booking.created', ?, ?)").run(endpointId, EVENT(100 + n), MAX_ATTEMPTS);
    const failed = Number(((await getDb().prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? AND attempts >= ? AND delivered_at IS NULL").get(endpointId, MAX_ATTEMPTS)) as { n: number }).n);
    expect(failed).toBeGreaterThan(50);
    expect(await redeliverFailed(venueId, { endpointId })).toEqual({ ok: true, requeued: 50 });
    // The listing shows the newest twenty and the true count.
    const [e] = await listEndpoints(venueId);
    expect(e.failedCount).toBe(failed - 50);
    expect(e.failed.length).toBeLessThanOrEqual(20);
    await getDb().prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?").run(endpointId);
  });
});

describe("who may send a delivery again", () => {
  it("only a manager of the owning venue: another venue's manager, a desk worker and a stranger get nothing, and nothing changes", async () => {
    receiverFailing(500);
    const id = await exhausted(20);
    const state = async () => JSON.stringify(await getDb().prepare("SELECT attempts, redeliveries, next_at FROM webhook_deliveries WHERE id = ?").get(id));
    const before = await state();
    // Another venue's manager naming this venue: refused as not theirs.
    expect((await integrationsPost(post(otherManagerCookie, { venueId, action: "redeliver", deliveryId: id }))).status).toBe(403);
    // ...or naming their own venue with this venue's delivery or address: not found, not done.
    const own = await integrationsPost(post(otherManagerCookie, { venueId: otherVenueId, action: "redeliver", deliveryId: id }));
    expect(own.status).toBe(404);
    expect((await integrationsPost(post(otherManagerCookie, { venueId: otherVenueId, action: "redeliver", id: endpointId }))).status).toBe(404);
    expect(await redeliverFailed(otherVenueId, { deliveryId: id })).toEqual({ ok: false, reason: "NOT_FOUND" });
    // Front desk is not a manager.
    expect((await integrationsPost(post(deskCookie, { venueId, action: "redeliver", deliveryId: id }))).status).toBe(403);
    // Nobody signed in.
    expect((await integrationsPost(post("", { venueId, action: "redeliver", deliveryId: id }))).status).toBe(401);
    expect(await state()).toBe(before);
    // The failed list is the venue's own, in the GET.
    const listed = await (await integrationsGet(new NextRequest(`http://localhost/api/admin/integrations?venueId=${otherVenueId}`, { headers: { cookie: otherManagerCookie } }))).json();
    expect(JSON.stringify(listed)).not.toContain("evt_test20");
    expect((await integrationsGet(new NextRequest(`http://localhost/api/admin/integrations?venueId=${venueId}`, { headers: { cookie: otherManagerCookie } }))).status).toBe(403);
    const mine = await (await integrationsGet(new NextRequest(`http://localhost/api/admin/integrations?venueId=${venueId}`, { headers: { cookie: managerCookie } }))).json();
    expect(mine.webhookRetry).toEqual({ tries: MAX_ATTEMPTS, days: RETENTION.webhookDeliveryDays, most: 50 });
    expect(mine.endpoints[0].failed.map((d: { eventId: string }) => d.eventId)).toContain("evt_test20");
    // A request naming nothing is a bad request; an unknown delivery is not found.
    expect((await integrationsPost(post(managerCookie, { venueId, action: "redeliver" }))).status).toBe(400);
    expect((await integrationsPost(post(managerCookie, { venueId, action: "redeliver", deliveryId: 99999999 }))).status).toBe(404);
  });

  it("is refused while the address is turned off, changing nothing, and works once it is back on", async () => {
    receiverFailing(500);
    const id = await exhausted(21);
    await getDb().prepare("UPDATE webhook_endpoints SET active = 0 WHERE id = ?").run(endpointId);
    const res = await integrationsPost(post(managerCookie, { venueId, action: "redeliver", deliveryId: id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Turn the address back on before sending an event again.");
    expect(await redeliverFailed(venueId, { endpointId })).toEqual({ ok: false, reason: "ENDPOINT_OFF" });
    expect(((await getDb().prepare("SELECT redeliveries FROM webhook_deliveries WHERE id = ?").get(id)) as { redeliveries: number }).redeliveries).toBe(0);
    await getDb().prepare("UPDATE webhook_endpoints SET active = 1 WHERE id = ?").run(endpointId);
    expect((await redeliverFailed(venueId, { deliveryId: id })).ok).toBe(true);
  });
});

describe("how long a failed delivery is kept", () => {
  it("is removed by retention after the period, and so is one waiting on an address that is off; one still to go to a live address is not", async () => {
    const db = getDb();
    await db.prepare("DELETE FROM webhook_deliveries").run();
    const old = `${addDays(todayISO(), -(RETENTION.webhookDeliveryDays + 2))} 00:00:00`;
    const insert = async (n: number, endpoint: number, attempts: number, created: string) =>
      ((await db.prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload, attempts, created_at) VALUES (?, 'booking.created', ?, ?, ?) RETURNING id").get(endpoint, EVENT(n), attempts, created)) as { id: number }).id;
    const off = ((await db.prepare("INSERT INTO webhook_endpoints (venue_id, url, secret, active) VALUES (?, 'https://off.example.com/x', 'x', 0) RETURNING id").get(venueId)) as { id: number }).id;
    const failedOld = await insert(30, endpointId, MAX_ATTEMPTS, old);
    const failedNew = await insert(31, endpointId, MAX_ATTEMPTS, `${todayISO()} 00:00:00`);
    const pendingLive = await insert(32, endpointId, 2, old);
    const pendingOff = await insert(33, off, 2, old);
    const pendingOffNew = await insert(34, off, 2, `${todayISO()} 00:00:00`);
    await pruneOldData();
    const left = ((await db.prepare("SELECT id FROM webhook_deliveries ORDER BY id").all()) as { id: number }[]).map((r) => r.id);
    expect(left).toEqual([failedNew, pendingLive, pendingOffNew]);
    expect(left).not.toContain(failedOld);
    expect(left).not.toContain(pendingOff);
  });
});

describe("migration 0321 on deliveries that already exist", () => {
  it("gives the last attempt of rows that have one to derive, and nothing to the rest, losing none", async () => {
    // The statements run on rows as the old code left them: written without last_attempt_at.
    const db = getDb();
    await db.prepare("DELETE FROM webhook_deliveries").run();
    const mk = async (attempts: number, nextAt: string, deliveredAt: string | null) =>
      ((await db.prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload, attempts, next_at, delivered_at) VALUES (?, 'ping', '{}', ?, ?, ?) RETURNING id").get(endpointId, attempts, nextAt, deliveredAt)) as { id: number }).id;
    const gaveUp = await mk(8, "2026-11-01 02:08:00", null);
    const delivered = await mk(1, "2026-11-01 00:00:00", "2026-11-01 00:05:00");
    const retrying = await mk(3, "2026-11-01 00:04:00", null);
    await db.prepare("UPDATE webhook_deliveries SET last_attempt_at = NULL").run();
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0321_webhook_failed_deliveries.sql"), "utf8");
    // Only the two data statements (the columns exist already): each is idempotent.
    const updates = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.startsWith("UPDATE"));
    expect(updates).toHaveLength(2);
    for (const u of updates) await db.exec(u);
    const at = async (id: number) => ((await db.prepare("SELECT last_attempt_at AS a FROM webhook_deliveries WHERE id = ?").get(id)) as { a: string | null }).a;
    // 8 attempts: the last failure set the next one 2^7 = 128 minutes on.
    expect(await at(gaveUp)).toBe("2026-11-01 00:00:00");
    expect(await at(delivered)).toBe("2026-11-01 00:05:00");
    expect(await at(retrying)).toBeNull();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()) as { n: number }).n)).toBe(3);
  });
});
