import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "./db";
import { rateLimit } from "./rate-limit";
import { roundMoney } from "./region";
import type { Booking } from "./types";

/**
 * Keys for the public API (`/api/v1`), each for one venue: its booking
 * screen, its own website, its accounting or door system.
 *
 * A key is shown once, when a manager makes it, and only its SHA-256 is
 * kept, so a copy of the database gives nobody the key. `read` keys see the
 * venue, its availability and its bookings (customers' names and numbers
 * included, as its staff see them); `write` keys can also book and cancel.
 * A key is revoked at once and for good.
 */

export const MAX_KEYS = 10;
/** What a key may do: see availability and the venue only; also read bookings; also book and cancel. */
export type ApiScope = "availability" | "read" | "write";
const RANK: Record<ApiScope, number> = { availability: 0, read: 1, write: 2 };

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scope: ApiScope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const hash = (key: string) => crypto.createHash("sha256").update(key, "utf8").digest("hex");

interface Row {
  id: number;
  venue_id: number;
  name: string;
  prefix: string;
  scope: ApiScope;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const toKey = (r: Row): ApiKey => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scope: r.scope,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export async function listApiKeys(venueId: number): Promise<ApiKey[]> {
  const rows = (await getDb().prepare("SELECT * FROM venue_api_keys WHERE venue_id = ? ORDER BY revoked_at IS NOT NULL, id DESC").all(venueId)) as Row[];
  return rows.map(toKey);
}

/** A new key: the whole of it returned this once. */
export async function createApiKey(
  venueId: number,
  input: { name: unknown; scope: unknown },
  adminId: number | null
): Promise<{ ok: true; key: string; record: ApiKey } | { ok: false; error: string }> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
  if (name.length < 2) return { ok: false, error: "Name the key after what will use it." };
  const scope: ApiScope = input.scope === "write" ? "write" : input.scope === "availability" ? "availability" : "read";
  const live = (await getDb().prepare("SELECT COUNT(*) AS n FROM venue_api_keys WHERE venue_id = ? AND revoked_at IS NULL").get(venueId)) as {
    n: number | string;
  };
  if (Number(live.n) >= MAX_KEYS) return { ok: false, error: `${MAX_KEYS} keys at most. Revoke one first.` };
  const key = `ms_${scope === "write" ? "w" : scope === "availability" ? "a" : "r"}_${crypto.randomBytes(24).toString("base64url")}`;
  const row = (await getDb()
    .prepare("INSERT INTO venue_api_keys (venue_id, name, prefix, key_hash, scope, admin_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .get(venueId, name, key.slice(0, 10), hash(key), scope, adminId)) as Row;
  return { ok: true, key, record: toKey(row) };
}

export async function revokeApiKey(id: number, venueId: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE venue_api_keys SET revoked_at = datetime('now') WHERE id = ? AND venue_id = ? AND revoked_at IS NULL")
    .run(id, venueId);
  return done.changes === 1;
}

export interface ApiCaller {
  keyId: number;
  venueId: number;
  scope: ApiScope;
}

/**
 * Who is calling, from `Authorization: Bearer <key>`, or the response to send
 * back: 401 without a good key, 403 for a read key asked to write, 429 when
 * it is calling too often.
 */
export async function apiCaller(req: NextRequest, need: ApiScope = "read"): Promise<ApiCaller | NextResponse> {
  const header = req.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^ms_[arw]_[A-Za-z0-9_-]{20,64}$/.test(key))
    return NextResponse.json({ error: "Give an API key: Authorization: Bearer <key>." }, { status: 401 });
  const row = (await getDb()
    .prepare("SELECT id, venue_id, scope, last_used_at FROM venue_api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .get(hash(key))) as { id: number; venue_id: number; scope: ApiScope; last_used_at: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "That API key is not valid, or was revoked." }, { status: 401 });
  if (RANK[row.scope] < RANK[need])
    return NextResponse.json(
      { error: row.scope === "availability" ? "This key can only see availability and the venue." : "This key can only read." },
      { status: 403 }
    );
  const limited = await rateLimit(req, "api", `key${row.id}`);
  if (limited) return limited;
  // Written at most once a minute, so a busy integration does not write on every call.
  if (!row.last_used_at || Date.parse(`${row.last_used_at.replace(" ", "T")}Z`) < Date.now() - 60_000)
    await getDb().prepare("UPDATE venue_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return { keyId: row.id, venueId: row.venue_id, scope: row.scope };
}

/** A booking as the API and webhooks give it. */
export function apiBooking(b: Booking & { courtName?: string; sport?: string }): Record<string, unknown> {
  return {
    code: b.code,
    status: b.status,
    paymentStatus: b.paymentStatus,
    date: b.date,
    // Minutes of the business day (past 1440 is after midnight), the moments
    // themselves, and the same in hours for older readers.
    startMin: b.startMin,
    endMin: b.endMin,
    startsAt: b.startsAt ?? null,
    endsAt: b.endsAt ?? null,
    startHour: b.startHour,
    endHour: b.endHour,
    courtId: b.courtId,
    ...(b.courtName ? { courtName: b.courtName } : {}),
    ...(b.sport ? { sport: b.sport } : {}),
    name: b.name,
    phone: b.phone,
    email: b.email,
    totalPrice: b.totalPrice,
    paidByOthers: roundMoney((b.sharesPaid ?? 0) - (b.depositPaid ?? 0)),
    depositPaid: roundMoney(b.depositPaid ?? 0),
    coachId: b.coachId ?? null,
    noShow: b.noShow,
    createdAt: b.createdAt,
    // Places it takes (or players, on a court priced per player); 1 for a court booked whole.
    players: b.players ?? 1,
  };
}
