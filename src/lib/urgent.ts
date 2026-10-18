import { randomBytes } from "node:crypto";
import { getDb } from "./db";

/**
 * News the customer must not miss — the venue cancelled their booking, or
 * moved it — kept open until somebody knows they have it.
 *
 * Each notice goes out on whatever reaches the customer (email, WhatsApp) with
 * a "Seen it" link. Tapping it closes the notice. Until then it sits on the
 * staff's list with how each message fared — sent, delivered, read, failed,
 * or nothing to send it on at all — so the desk knows whom to ring. Staff
 * can close it themselves once they have told the customer another way.
 */

export type NoticeKind = "cancelled" | "moved";

export interface NoticeMessage {
  id: number;
  channel: "whatsapp" | "email";
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  error: string | null;
}

export interface UrgentNotice {
  id: number;
  venueId: number;
  bookingId: number | null;
  kind: NoticeKind;
  name: string;
  phone: string;
  email: string | null;
  date: string;
  startHour: number;
  summary: string;
  createdAt: string;
  ackedAt: string | null;
  resolvedAt: string | null;
  resolution: "acknowledged" | "told" | null;
  messages: NoticeMessage[];
  /** The best that is known: how far the news has got. */
  reach: "acknowledged" | "told" | "read" | "delivered" | "sent" | "waiting" | "failed" | "unreachable";
}

interface NoticeRow {
  id: number;
  venue_id: number;
  booking_id: number | null;
  kind: NoticeKind;
  name: string;
  phone: string;
  email: string | null;
  date: string;
  start_hour: number;
  summary: string;
  created_at: string;
  acked_at: string | null;
  resolved_at: string | null;
  resolution: "acknowledged" | "told" | null;
}

export async function createNotice(input: {
  venueId: number;
  bookingId: number;
  kind: NoticeKind;
  name: string;
  phone: string;
  email: string | null;
  date: string;
  startHour: number;
  summary: string;
}): Promise<{ id: number; token: string }> {
  const token = randomBytes(12).toString("base64url");
  const info = await getDb()
    .prepare(
      `INSERT INTO urgent_notices (venue_id, booking_id, kind, name, phone, email, date, start_hour, summary, ack_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.venueId, input.bookingId, input.kind, input.name, input.phone, input.email, input.date, input.startHour, input.summary, token);
  return { id: info.lastInsertRowid as number, token };
}

function reachOf(row: NoticeRow, messages: NoticeMessage[]): UrgentNotice["reach"] {
  if (row.resolution === "acknowledged") return "acknowledged";
  if (row.resolution === "told") return "told";
  if (messages.length === 0) return "unreachable";
  if (messages.some((m) => m.readAt)) return "read";
  if (messages.some((m) => m.deliveredAt)) return "delivered";
  if (messages.some((m) => m.status === "sent" && !m.error)) return "sent";
  if (messages.every((m) => m.status === "abandoned" || m.error)) return "failed";
  return "waiting";
}

async function withMessages(rows: NoticeRow[]): Promise<UrgentNotice[]> {
  if (rows.length === 0) return [];
  const msgs = (await getDb()
    .prepare(
      `SELECT id, notice_id, channel, status, sent_at, delivered_at, read_at, COALESCE(delivery_error, CASE WHEN status = 'abandoned' THEN last_error END) AS error
         FROM messages WHERE notice_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`
    )
    .all(...rows.map((r) => r.id))) as {
    id: number;
    notice_id: number;
    channel: "whatsapp" | "email";
    status: string;
    sent_at: string | null;
    delivered_at: string | null;
    read_at: string | null;
    error: string | null;
  }[];
  return rows.map((r) => {
    const messages = msgs
      .filter((m) => m.notice_id === r.id)
      .map((m) => ({ id: m.id, channel: m.channel, status: m.status, sentAt: m.sent_at, deliveredAt: m.delivered_at, readAt: m.read_at, error: m.error }));
    return {
      id: r.id,
      venueId: r.venue_id,
      bookingId: r.booking_id,
      kind: r.kind,
      name: r.name,
      phone: r.phone,
      email: r.email,
      date: r.date,
      startHour: r.start_hour,
      summary: r.summary,
      createdAt: r.created_at,
      ackedAt: r.acked_at,
      resolvedAt: r.resolved_at,
      resolution: r.resolution,
      messages,
      reach: reachOf(r, messages),
    };
  });
}

/** Still open at these venues, the soonest booking first. */
export async function openNotices(venueIds: number[] | null): Promise<UrgentNotice[]> {
  if (venueIds && venueIds.length === 0) return [];
  const only = venueIds ? ` AND venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const rows = (await getDb()
    .prepare(`SELECT * FROM urgent_notices WHERE resolved_at IS NULL${only} ORDER BY date, start_hour, id`)
    .all(...(venueIds ?? []))) as NoticeRow[];
  return withMessages(rows);
}

/** Closed in the last week, for the record. */
export async function recentlyClosed(venueIds: number[] | null, limit = 20): Promise<UrgentNotice[]> {
  if (venueIds && venueIds.length === 0) return [];
  const only = venueIds ? ` AND venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM urgent_notices WHERE resolved_at IS NOT NULL AND resolved_at >= datetime('now', '-7 days')${only}
        ORDER BY resolved_at DESC LIMIT ?`
    )
    .all(...(venueIds ?? []), limit)) as NoticeRow[];
  return withMessages(rows);
}

export async function noticeById(id: number): Promise<UrgentNotice | null> {
  const row = (await getDb().prepare("SELECT * FROM urgent_notices WHERE id = ?").get(id)) as NoticeRow | undefined;
  return row ? (await withMessages([row]))[0] : null;
}

/** What the "Seen it" page shows before the customer taps. */
export async function noticeByToken(token: string): Promise<{ summary: string; ackedAt: string | null } | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
  const row = (await getDb().prepare("SELECT summary, acked_at FROM urgent_notices WHERE ack_token = ?").get(token)) as
    | { summary: string; acked_at: string | null }
    | undefined;
  return row ? { summary: row.summary, ackedAt: row.acked_at } : null;
}

/** The customer has seen it. */
export async function acknowledge(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return false;
  const row = (await getDb().prepare("SELECT id FROM urgent_notices WHERE ack_token = ?").get(token)) as { id: number } | undefined;
  if (!row) return false;
  await getDb()
    .prepare(
      `UPDATE urgent_notices SET acked_at = COALESCE(acked_at, datetime('now')),
              resolved_at = COALESCE(resolved_at, datetime('now')),
              resolution = COALESCE(resolution, 'acknowledged')
        WHERE id = ?`
    )
    .run(row.id);
  return true;
}

/** Staff told the customer another way — a call, at the counter. */
export async function markTold(id: number, adminId: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE urgent_notices SET resolved_at = datetime('now'), resolved_by = ?, resolution = 'told' WHERE id = ? AND resolved_at IS NULL")
    .run(adminId, id);
  return done.changes === 1;
}
