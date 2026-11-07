import crypto from "crypto";
import { hoursOf } from "./interval";
import dns from "dns";
import https from "https";
import net from "net";
import { getDb } from "./db";
import type { Admin } from "./admin-auth";
import { OWNER_CURRENT, mayHoldCredentialAt, type Ownership } from "./credential-owners";
import { tellVenueStaffEach } from "./owner-alerts";
import { seal, unseal } from "./secrets";
import { siteName } from "./site";
import { addDays } from "./time";

/**
 * Telling a venue's own systems when its bookings change, by HTTPS POST.
 *
 * - **What is sent:** `booking.created`, `booking.cancelled`, `booking.paid`
 *   and `booking.changed` (moved to another date, time or court), each with
 *   the booking as the API gives it. Found by a sweep that compares each
 *   booking with what was last sent (`webhook_seen`), so a change is caught
 *   however it was made: online, at the desk, by a payment arriving.
 * - **Signed:** `MySenam-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 *   "<t>.<body>">` with the endpoint's secret, shown once when it is added.
 *   A receiver checks it, and that `t` is recent, before trusting the body.
 * - **Retried** with growing waits (1, 2, 4… minutes, at most six hours) up
 *   to eight times; an endpoint failing for a day is turned off and the
 *   venue's staff told. Each event has an `id` to recognise a repeat by.
 * - **Only to the public internet:** an address must be HTTPS and must not
 *   resolve to a private, loopback or link-local address. The check is the
 *   lookup the connection itself uses (`pinnedLookup`), so a name that
 *   answers differently a moment later (DNS rebinding) cannot slip past it.
 * - **Whose it is:** a person's address stops, and nothing more is sent to it, when its owner no longer manages the venue; the venue's
 *   own address does not depend on whoever added it (lib/credential-owners.ts, ADR 0064). Checked when an event is queued and again
 *   when it is sent, so one queued before the person left is not delivered after.
 */

export const WEBHOOK_EVENTS = ["booking.created", "booking.cancelled", "booking.paid", "booking.changed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | "ping";
export const MAX_ENDPOINTS = 5;
const MAX_ATTEMPTS = 8;

export interface Endpoint {
  id: number;
  url: string;
  active: boolean;
  createdAt: string;
  failingSince: string | null;
  /** Whose it is: a person's stops when they stop managing the venue; the venue's does not. */
  ownership: Ownership;
  ownerId: number | null;
  ownerName: string | null;
  madeBy: string | null;
  /** Why the system turned it off where it did (its owner left); null otherwise. */
  stoppedReason: string | null;
  /** A person's address whose owner no longer has the authority for it: nothing is sent to it. */
  ownerLost: boolean;
  recent: { event: string; status: number | null; deliveredAt: string | null; attempts: number; error: string | null; at: string }[];
}

/** An address a webhook may go to, written down; whether it resolves somewhere public is checked when sent. */
function readUrl(raw: unknown): URL | string {
  if (typeof raw !== "string") return "Give the address to send to.";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:") return "The address must start with https://.";
  if (url.username || url.password) return "Leave the user name and password out of the address.";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || isPrivate(host))
    return "The address must be on the public internet.";
  return url;
}

/** Private, loopback, link-local, carrier-grade NAT and other addresses nothing public lives at. */
export function isPrivate(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224 ||
      // Protocol assignments, documentation and benchmarking ranges: never a real receiver.
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    // Site-local (deprecated, still routed by some), documentation, and multicast.
    if (/^fe[c-f]/.test(v) || v.startsWith("2001:db8:") || v.startsWith("ff")) return true;
    // An IPv4 address carried inside IPv6, dotted or in hex (::ffff:7f00:1), mapped, compatible or
    // through NAT64 (64:ff9b::): judged as the IPv4 address it is.
    const dotted = v.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivate(dotted[1]);
    const hex = v.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return isPrivate(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return false;
}

export async function addEndpoint(
  venueId: number,
  rawUrl: unknown,
  who: { adminId: number | null; ownership?: unknown } = { adminId: null }
): Promise<{ ok: true; secret: string; endpoint: Endpoint } | { ok: false; error: string }> {
  const url = readUrl(rawUrl);
  if (typeof url === "string") return { ok: false, error: url };
  const db = getDb();
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints WHERE venue_id = ?").get(venueId)) as { n: number | string };
  if (Number(count.n) >= MAX_ENDPOINTS) return { ok: false, error: `${MAX_ENDPOINTS} addresses at most. Remove one first.` };
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  // A person's unless the manager says it is the venue's: an address nobody said anything about stops with the person who added it.
  const ownership: Ownership = who.ownership === "venue" || who.adminId === null ? "venue" : "person";
  const row = (await db
    .prepare("INSERT INTO webhook_endpoints (venue_id, url, secret, admin_id, ownership, owner_admin_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .get(venueId, url.toString(), seal(secret), who.adminId, ownership, ownership === "person" ? who.adminId : null)) as { id: number };
  return { ok: true, secret, endpoint: (await listEndpoints(venueId)).find((e) => e.id === row.id)! };
}

export async function removeEndpoint(id: number, venueId: number): Promise<boolean> {
  const done = await getDb().prepare("DELETE FROM webhook_endpoints WHERE id = ? AND venue_id = ?").run(id, venueId);
  return done.changes === 1;
}

/**
 * Back on after it was turned off for failing. Not for a person's address whose owner no longer manages the venue: its secret was theirs,
 * so it is replaced (rotated), not revived.
 */
export async function resumeEndpoint(id: number, venueId: number): Promise<boolean> {
  const done = await getDb()
    .prepare(`UPDATE webhook_endpoints e SET active = 1, failing_since = NULL, stopped_reason = NULL WHERE e.id = ? AND e.venue_id = ? AND ${OWNER_CURRENT("e")}`)
    .run(id, venueId);
  return done.changes === 1;
}

export type EndpointChange = { ok: true; detail: string; secret?: string } | { ok: false; error: string; status: number };

/** Hand an address to the venue or to a person who manages it now, by a manager (on the record). Not one whose owner has lost the authority. */
export async function reassignEndpoint(id: number, venueId: number, to: "venue" | number, by: Admin): Promise<EndpointChange> {
  const db = getDb();
  const e = (await db
    .prepare(
      `SELECT e.url, e.ownership, o.name AS owner_name, (e.ownership = 'person' AND NOT ${OWNER_CURRENT("e")}) AS owner_lost
         FROM webhook_endpoints e LEFT JOIN admins o ON o.id = e.owner_admin_id WHERE e.id = ? AND e.venue_id = ?`
    )
    .get(id, venueId)) as { url: string; ownership: Ownership; owner_name: string | null; owner_lost: boolean } | undefined;
  if (!e) return { ok: false, error: "Address not found.", status: 404 };
  if (e.owner_lost)
    return { ok: false, error: "That address's owner no longer manages this venue, so it stays stopped. Add it again, or rotate it, instead.", status: 409 };
  if (to !== "venue" && !(await mayHoldCredentialAt(to, venueId))) return { ok: false, error: "That person does not manage this venue.", status: 409 };
  const target = to === "venue" ? null : to;
  await db.prepare("UPDATE webhook_endpoints SET ownership = ?, owner_admin_id = ? WHERE id = ? AND venue_id = ?").run(target === null ? "venue" : "person", target, id, venueId);
  const who = target === null ? null : (((await db.prepare("SELECT name FROM admins WHERE id = ?").get(target)) as { name: string } | undefined)?.name ?? null);
  return { ok: true, detail: `Webhook ${e.url} handed from ${e.ownership === "venue" ? "the venue" : (e.owner_name ?? "its owner")} to ${who ?? "the venue"} by ${by.name}` };
}

/**
 * A new signing secret for an address, the old one dead at once (shown this once): the remedy for a secret somebody who should no longer
 * have it may have seen. The address is the venue's if it was, else belongs to whoever rotates it; where it had stopped because its owner
 * left it is on again.
 */
export async function rotateEndpointSecret(id: number, venueId: number, by: Admin): Promise<EndpointChange> {
  const db = getDb();
  const e = (await db.prepare("SELECT url, ownership FROM webhook_endpoints WHERE id = ? AND venue_id = ?").get(id, venueId)) as { url: string; ownership: Ownership } | undefined;
  if (!e) return { ok: false, error: "Address not found.", status: 404 };
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  await db
    .prepare("UPDATE webhook_endpoints SET secret = ?, owner_admin_id = ?, active = 1, failing_since = NULL, stopped_reason = NULL WHERE id = ? AND venue_id = ?")
    .run(seal(secret), e.ownership === "person" ? by.id : null, id, venueId);
  return { ok: true, secret, detail: `Webhook ${e.url} rotated by ${by.name}: a new signing secret was made, the old one stopped` };
}

export async function listEndpoints(venueId: number): Promise<Endpoint[]> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT e.id, e.url, e.active, e.created_at, e.failing_since, e.ownership, e.owner_admin_id, e.stopped_reason, o.name AS owner_name, m.name AS made_by,
              (e.ownership = 'person' AND NOT ${OWNER_CURRENT("e")}) AS owner_lost
         FROM webhook_endpoints e LEFT JOIN admins o ON o.id = e.owner_admin_id LEFT JOIN admins m ON m.id = e.admin_id
        WHERE e.venue_id = ? ORDER BY e.id`
    )
    .all(venueId)) as {
    id: number;
    url: string;
    active: number;
    created_at: string;
    failing_since: string | null;
    ownership: Ownership;
    owner_admin_id: number | null;
    stopped_reason: string | null;
    owner_name: string | null;
    made_by: string | null;
    owner_lost: boolean;
  }[];
  const out: Endpoint[] = [];
  for (const r of rows) {
    const recent = (await db
      .prepare(
        "SELECT event, last_status, delivered_at, attempts, last_error, created_at FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 10"
      )
      .all(r.id)) as { event: string; last_status: number | null; delivered_at: string | null; attempts: number; last_error: string | null; created_at: string }[];
    out.push({
      id: r.id,
      url: r.url,
      active: r.active === 1,
      createdAt: r.created_at,
      failingSince: r.failing_since,
      ownership: r.ownership,
      ownerId: r.owner_admin_id,
      ownerName: r.owner_name,
      madeBy: r.made_by,
      stoppedReason: r.stopped_reason,
      ownerLost: r.owner_lost === true,
      recent: recent.map((d) => ({ event: d.event, status: d.last_status, deliveredAt: d.delivered_at, attempts: d.attempts, error: d.last_error, at: d.created_at })),
    });
  }
  return out;
}

async function queue(venueId: number, event: WebhookEvent, data: Record<string, unknown>, onlyEndpoint?: number): Promise<number> {
  const db = getDb();
  const endpoints = (await db
    .prepare(`SELECT e.id FROM webhook_endpoints e WHERE e.venue_id = ? AND e.active = 1 AND ${OWNER_CURRENT("e")}${onlyEndpoint ? " AND e.id = ?" : ""}`)
    .all(...(onlyEndpoint ? [venueId, onlyEndpoint] : [venueId]))) as { id: number }[];
  for (const e of endpoints) {
    const payload = JSON.stringify({ id: `evt_${crypto.randomBytes(12).toString("hex")}`, type: event, created: new Date().toISOString(), data });
    await db.prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES (?, ?, ?)").run(e.id, event, payload);
  }
  return endpoints.length;
}

/** A test message to one address, to see the receiver works. */
export async function pingEndpoint(id: number, venueId: number): Promise<boolean> {
  return (await queue(venueId, "ping", { message: `A test from ${siteName()}.` }, id)) > 0;
}

interface SeenRow {
  id: number;
  venue_id: number;
  code: string;
  status: string;
  payment_status: string;
  date: string;
  start_min: number;
  end_min: number;
  court_id: number;
  court_name: string;
  sport: string;
  name: string;
  phone: string;
  email: string | null;
  total_price: number | string;
  shares_paid: number | string;
  deposit_paid: number | string;
  coach_id: number | null;
  no_show: number;
  created_at: string;
  seen: string | null;
}

const stateOf = (r: SeenRow) =>
  JSON.stringify({ s: r.status, p: r.payment_status, d: r.date, m: [r.start_min, r.end_min], c: r.court_id });

const bookingOf = (r: SeenRow) => ({
  code: r.code,
  status: r.status,
  paymentStatus: r.payment_status,
  date: r.date,
  // Minutes of the business day, and the same in hours for older receivers.
  startMin: r.start_min,
  endMin: r.end_min,
  startHour: hoursOf(r.start_min),
  endHour: hoursOf(r.end_min),
  courtId: r.court_id,
  courtName: r.court_name,
  sport: r.sport,
  name: r.name,
  phone: r.phone,
  email: r.email,
  totalPrice: Number(r.total_price),
  paidByOthers: Math.round((Number(r.shares_paid) - Number(r.deposit_paid)) * 100) / 100,
  depositPaid: Number(r.deposit_paid),
  coachId: r.coach_id,
  noShow: r.no_show === 1,
  createdAt: r.created_at,
});

/**
 * Compare each booking at venues with webhooks, from yesterday to four months
 * ahead, with what was last sent, and queue an event for what changed. A
 * booking never seen and made more than two days ago (from before the
 * webhook was added) is noted without an event.
 */
export async function sweepWebhookEvents(now = new Date()): Promise<number> {
  const db = getDb();
  const venues = (await db.prepare(`SELECT DISTINCT e.venue_id FROM webhook_endpoints e WHERE e.active = 1 AND ${OWNER_CURRENT("e")}`).all()) as { venue_id: number }[];
  if (venues.length === 0) return 0;
  const today = now.toISOString().slice(0, 10);
  const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  let queued = 0;
  for (const { venue_id } of venues) {
    const rows = (await db
      .prepare(
        `SELECT b.id, c.venue_id, b.code, b.status, b.payment_status, b.date, b.start_min, b.end_min, b.court_id, c.name AS court_name,
                b.sport, b.name, b.phone, b.email, b.total_price, b.shares_paid, b.deposit_paid, b.coach_id, b.no_show, b.created_at, w.state AS seen
           FROM bookings b JOIN courts c ON c.id = b.court_id LEFT JOIN webhook_seen w ON w.booking_id = b.id
          WHERE c.venue_id = ? AND b.demo = 0 AND b.date BETWEEN ? AND ?`
      )
      .all(venue_id, addDays(today, -1), addDays(today, 120))) as SeenRow[];
    for (const r of rows) {
      const state = stateOf(r);
      if (r.seen === state) continue;
      let event: WebhookEvent | null = null;
      if (r.seen === null) {
        if (r.created_at >= recent && r.status === "confirmed") event = "booking.created";
      } else {
        const was = JSON.parse(r.seen) as { s: string; p: string; d: string; m?: number[]; c: number };
        if (was.s !== r.status && r.status === "cancelled") event = "booking.cancelled";
        else if (was.p !== r.payment_status && r.payment_status === "paid") event = "booking.paid";
        else if (was.d !== r.date || was.m?.[0] !== r.start_min || was.m?.[1] !== r.end_min || was.c !== r.court_id) event = "booking.changed";
      }
      if (event) queued += await queue(venue_id, event, { booking: bookingOf(r) });
      await db
        .prepare("INSERT INTO webhook_seen (booking_id, state) VALUES (?, ?) ON CONFLICT (booking_id) DO UPDATE SET state = excluded.state")
        .run(r.id, state);
    }
  }
  return queued;
}

export function signature(secret: string, body: string, at: number): string {
  return `t=${at},v1=${crypto.createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

const NOT_PUBLIC = "The address does not lead to the public internet.";

/**
 * Where a webhook's host is, for the connection itself: every address the
 * name resolves to must be public, and the connection is made to one of
 * exactly those. Checking with one lookup and connecting after another would
 * let a name that changes in between reach the server's own network.
 */
export function pinnedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  dns.promises
    .lookup(hostname, { all: true })
    .then((all) => {
      const found = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
      if (found.length === 0 || all.some((a) => isPrivate(a.address))) return callback(Object.assign(new Error(NOT_PUBLIC), { code: "ENOTPUBLIC" }), []);
      if (options.all) callback(null, found);
      else callback(null, found[0].address, found[0].family);
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, []));
}

/** How a delivery goes out: one HTTPS POST, its status. A seam for the tests. */
export const transport = {
  post(url: URL, headers: Record<string, string>, body: string, timeoutMs = 10_000): Promise<number> {
    // An address written as a number is not looked up: it is judged as it is.
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivate(url.hostname)) return Promise.reject(new Error(NOT_PUBLIC));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
          lookup: pinnedLookup as never,
          signal: AbortSignal.timeout(timeoutMs),
        },
        (res) => {
          // Redirects are not followed: the status is the answer.
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  },
};

/** Send what is due; retry what failed, later. */
export async function deliverWebhooks(now = new Date()): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  const stamp = now.toISOString().replace("T", " ").slice(0, 19);
  const due = (await db
    .prepare(
      `SELECT d.id, d.payload, d.attempts, e.id AS endpoint_id, e.venue_id, e.url, e.secret, e.failing_since
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.delivered_at IS NULL AND d.attempts < ? AND d.next_at <= ? AND e.active = 1 AND ${OWNER_CURRENT("e")}
        ORDER BY d.id LIMIT 100`
    )
    .all(MAX_ATTEMPTS, stamp)) as {
    id: number;
    payload: string;
    attempts: number;
    endpoint_id: number;
    venue_id: number;
    url: string;
    secret: string;
    failing_since: string | null;
  }[];
  let sent = 0;
  let failed = 0;
  // Each one is claimed before it goes, by moving when it is next due past
  // the send's own time limit: another instance delivering at the same moment
  // finds it taken, and one that dies mid-send leaves it to be tried again.
  const claim = db.prepare(
    "UPDATE webhook_deliveries SET next_at = ? WHERE id = ? AND delivered_at IS NULL AND next_at <= ? RETURNING id"
  );
  const held = new Date(now.getTime() + 2 * 60_000).toISOString().replace("T", " ").slice(0, 19);
  for (const d of due) {
    if (!(await claim.get(held, d.id, stamp))) continue;
    let status: number | null = null;
    let error: string | null = null;
    const secret = unseal(d.secret);
    try {
      if (!secret) throw new Error("The signing secret cannot be read on this install. Add the address again.");
      const at = Math.floor(now.getTime() / 1000);
      status = await transport.post(
        new URL(d.url),
        { "Content-Type": "application/json", "User-Agent": `${siteName()}-Webhooks/1`, "MySenam-Signature": signature(secret, d.payload, at) },
        d.payload
      );
      if (status < 200 || status >= 300) error = `Answered ${status}`;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 300) : "Could not be reached";
    }
    if (!error) {
      await db.prepare("UPDATE webhook_deliveries SET delivered_at = ?, attempts = attempts + 1, last_status = ?, last_error = NULL WHERE id = ?").run(stamp, status, d.id);
      await db.prepare("UPDATE webhook_endpoints SET failing_since = NULL WHERE id = ?").run(d.endpoint_id);
      sent++;
      continue;
    }
    failed++;
    const wait = Math.min(2 ** d.attempts, 360) * 60_000;
    await db
      .prepare("UPDATE webhook_deliveries SET attempts = attempts + 1, last_status = ?, last_error = ?, next_at = ? WHERE id = ?")
      .run(status, error, new Date(now.getTime() + wait).toISOString().replace("T", " ").slice(0, 19), d.id);
    if (!d.failing_since) {
      await db.prepare("UPDATE webhook_endpoints SET failing_since = ? WHERE id = ?").run(stamp, d.endpoint_id);
    } else if (Date.parse(`${d.failing_since.replace(" ", "T")}Z`) < now.getTime() - 86_400_000) {
      const off = await db.prepare("UPDATE webhook_endpoints SET active = 0 WHERE id = ? AND active = 1").run(d.endpoint_id);
      if (off.changes === 1)
        await tellVenueStaffEach(d.venue_id, (t) => ({
          subject: t("r9d.hook.s"),
          body: t("r9d.hook.b", { url: d.url, error, place: `${t("sh.tab.venuesStaff")} → ${t("int.title")}` }),
        }));
    }
  }
  return { sent, failed };
}

export async function runWebhooks(now = new Date()): Promise<void> {
  await sweepWebhookEvents(now);
  await deliverWebhooks(now);
}
