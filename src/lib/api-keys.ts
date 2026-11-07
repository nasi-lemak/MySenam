import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDb, withTransaction } from "./db";
import type { Admin } from "./admin-auth";
import { OWNER_CURRENT, mayHoldCredentialAt, type Ownership } from "./credential-owners";
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
 *
 * A key is a person's or the venue's (lib/credential-owners.ts, ADR 0064): a person's works only while its owner is still a manager of the
 * venue, checked on every request, so removing or demoting them ends it at once; the venue's keeps working when whoever made it leaves.
 * While its venue (or its whole business) is suspended, a key may read but not write: nothing new is sold through it.
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
  /** Whose it is: a person's stops when they stop managing the venue; the venue's does not. */
  ownership: Ownership;
  /** The person who owns it (a person's key), by name; null for the venue's, or an owner whose account is gone. */
  ownerName: string | null;
  ownerId: number | null;
  /** Who made it, by name, where that is still known. */
  madeBy: string | null;
  /** Why it stopped, where the system stopped it (its owner left); null for one revoked by hand or still working. */
  revokedReason: string | null;
  /** A person's key whose owner no longer has the authority for it: it does not work, whether or not it was marked. */
  ownerLost: boolean;
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
  ownership?: Ownership;
  owner_admin_id?: number | null;
  owner_name?: string | null;
  made_by?: string | null;
  revoked_reason?: string | null;
  owner_lost?: boolean;
}

const toKey = (r: Row): ApiKey => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scope: r.scope,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  ownership: r.ownership ?? "venue",
  ownerName: r.owner_name ?? null,
  ownerId: r.owner_admin_id ?? null,
  madeBy: r.made_by ?? null,
  revokedReason: r.revoked_reason ?? null,
  ownerLost: r.owner_lost === true,
});

/** The columns a key is listed with: who owns it, who made it, and whether its owner still has the authority. */
const LISTED = `k.*, o.name AS owner_name, m.name AS made_by, (k.ownership = 'person' AND NOT ${OWNER_CURRENT("k")}) AS owner_lost`;
const LISTED_FROM = "venue_api_keys k LEFT JOIN admins o ON o.id = k.owner_admin_id LEFT JOIN admins m ON m.id = k.admin_id";

export async function listApiKeys(venueId: number): Promise<ApiKey[]> {
  const rows = (await getDb()
    .prepare(`SELECT ${LISTED} FROM ${LISTED_FROM} WHERE k.venue_id = ? ORDER BY k.revoked_at IS NOT NULL, k.id DESC`)
    .all(venueId)) as Row[];
  return rows.map(toKey);
}

/** A new key: the whole of it returned this once. */
export async function createApiKey(
  venueId: number,
  input: { name: unknown; scope: unknown; ownership?: unknown },
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
  // A person's unless the manager says it is the venue's: a key nobody said anything about stops with the person who made it.
  const ownership: Ownership = input.ownership === "venue" || adminId === null ? "venue" : "person";
  const row = (await getDb()
    .prepare(
      "INSERT INTO venue_api_keys (venue_id, name, prefix, key_hash, scope, admin_id, ownership, owner_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    )
    .get(venueId, name, key.slice(0, 10), hash(key), scope, adminId, ownership, ownership === "person" ? adminId : null)) as { id: number };
  const listed = (await listApiKeys(venueId)).find((k) => k.id === row.id)!;
  return { ok: true, key, record: listed };
}

export async function revokeApiKey(id: number, venueId: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE venue_api_keys SET revoked_at = datetime('now') WHERE id = ? AND venue_id = ? AND revoked_at IS NULL")
    .run(id, venueId);
  return done.changes === 1;
}

export type OwnerChange = { ok: true; detail: string } | { ok: false; error: string; status: number };

/**
 * Hand a key to the venue (it then outlives any person) or to a person who manages the venue now (`to` an admin's id): by a manager of the
 * venue, who is on the record. A key whose owner no longer has the authority for it is not handed on: its secret was theirs, so it is
 * rotated (a new key), not revived.
 */
export async function reassignApiKey(id: number, venueId: number, to: "venue" | number, by: Admin): Promise<OwnerChange> {
  const db = getDb();
  const key = (await db.prepare(`SELECT ${LISTED} FROM ${LISTED_FROM} WHERE k.id = ? AND k.venue_id = ?`).get(id, venueId)) as Row | undefined;
  if (!key || key.revoked_at) return { ok: false, error: "Key not found.", status: 404 };
  if (key.owner_lost)
    return { ok: false, error: "That key's owner no longer manages this venue, so it stays stopped. Make a new key (rotate it) instead.", status: 409 };
  if (to !== "venue" && !(await mayHoldCredentialAt(to, venueId))) return { ok: false, error: "That person does not manage this venue.", status: 409 };
  const target = to === "venue" ? null : to;
  const done = await db
    .prepare("UPDATE venue_api_keys SET ownership = ?, owner_admin_id = ? WHERE id = ? AND venue_id = ? AND revoked_at IS NULL")
    .run(target === null ? "venue" : "person", target, id, venueId);
  if (done.changes !== 1) return { ok: false, error: "Key not found.", status: 404 };
  const who = target === null ? null : (((await db.prepare("SELECT name FROM admins WHERE id = ?").get(target)) as { name: string } | undefined)?.name ?? null);
  const was = key.ownership === "venue" ? "the venue" : (key.owner_name ?? "its owner");
  return { ok: true, detail: `API key ${key.name} handed from ${was} to ${who ?? "the venue"} by ${by.name}` };
}

class NotRotated extends Error {}

/**
 * Replace a key with a new one of the same name and reach and end the old at once, in one step: the remedy for a key that may have been
 * seen by somebody who should no longer have it. The new key is the venue's if the old one was, else belongs to whoever rotates it.
 */
export async function rotateApiKey(
  id: number,
  venueId: number,
  by: Admin
): Promise<{ ok: true; key: string; record: ApiKey; detail: string } | { ok: false; error: string; status: number }> {
  const db = getDb();
  const old = (await db.prepare("SELECT name, scope, ownership FROM venue_api_keys WHERE id = ? AND venue_id = ? AND revoked_at IS NULL").get(id, venueId)) as
    | { name: string; scope: ApiScope; ownership: Ownership }
    | undefined;
  if (!old) return { ok: false, error: "Key not found.", status: 404 };
  try {
    return await withTransaction(async () => {
      const ended = await getDb()
        .prepare("UPDATE venue_api_keys SET revoked_at = datetime('now'), revoked_reason = ? WHERE id = ? AND venue_id = ? AND revoked_at IS NULL")
        .run("rotated", id, venueId);
      if (ended.changes !== 1) throw new NotRotated("Key not found.");
      const made = await createApiKey(venueId, { name: old.name, scope: old.scope, ownership: old.ownership }, by.id);
      if (!made.ok) throw new NotRotated(made.error);
      return { ok: true as const, key: made.key, record: made.record, detail: `API key ${old.name} rotated by ${by.name}: the old key stopped and a new one was made` };
    });
  } catch (err) {
    if (err instanceof NotRotated) return { ok: false, error: err.message, status: 404 };
    throw err;
  }
}

export interface ApiCaller {
  keyId: number;
  venueId: number;
  scope: ApiScope;
  /** Its venue or business is suspended: reads only. */
  suspended?: boolean;
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
  // Who it belongs to, and the venue and business it is for, are read with the key on every request: a person's key whose owner no longer
  // manages the venue is no key at all, the moment that changed (ADR 0064), and a suspended venue's or business's keys may not write.
  const row = (await getDb()
    .prepare(
      `SELECT k.id, k.venue_id, k.scope, k.last_used_at, (v.suspended_at IS NOT NULL OR b.suspended_at IS NOT NULL) AS suspended
         FROM venue_api_keys k JOIN venues v ON v.id = k.venue_id LEFT JOIN businesses b ON b.id = v.business_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL AND ${OWNER_CURRENT("k")}`
    )
    .get(hash(key))) as { id: number; venue_id: number; scope: ApiScope; last_used_at: string | null; suspended: boolean } | undefined;
  if (!row) return NextResponse.json({ error: "That API key is not valid, or was revoked." }, { status: 401 });
  if (row.suspended && need === "write")
    return NextResponse.json({ error: "This venue is suspended, so nothing new can be booked through its keys. Reading still works." }, { status: 403 });
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
  return { keyId: row.id, venueId: row.venue_id, scope: row.scope, suspended: row.suspended === true };
}

/**
 * Who takes part in a booking, as the API gives it (lib/participant-bookings.ts):
 * each participant by id and name, and the customer where they take a place
 * alongside them. Empty for a booking its customer takes alone, as every
 * booking before participants was.
 */
export async function apiParticipants(bookingId: number): Promise<{ participantId: number | null; name: string | null; customer: boolean }[]> {
  const rows = (await getDb()
    .prepare("SELECT takes_part_as, participant_id, name FROM booking_participants WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { takes_part_as: "customer" | "participant"; participant_id: number | null; name: string | null }[];
  if (!rows.some((r) => r.takes_part_as === "participant")) return [];
  return rows.map((r) => ({ participantId: r.participant_id, name: r.name, customer: r.takes_part_as === "customer" }));
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
    // Sold by the game: how many games; and a lane given on arrival, its lane still provisional until check-in (lib/lanes.ts).
    ...(b.games ? { games: b.games } : {}),
    ...(b.laneOnArrival ? { laneOnArrival: true, laneProvisional: !b.checkedInAt } : {}),
  };
}
