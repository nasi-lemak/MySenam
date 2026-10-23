import { isKnownActivity } from "./activity-registry";
import { getDb } from "./db";
import { type Refusal, type Sport } from "./types";
import type { Span } from "./interval";
import { errorText, translator, type ErrorCode } from "./i18n";

/**
 * Extras with a booking: a racket and a tube of shuttles for a casual player,
 * bibs for futsal, a mat for a class, a towel, a drink.
 *
 * Each venue keeps a short list. A rental is handed out for the booking and
 * comes back, and there are only so many: a racket hired from 8 to 10 is not
 * there for somebody else at 9. A sale is kept. Either can be offered only
 * with one sport's courts and classes.
 *
 * They are offered, never chosen for the customer, when booking and when
 * enrolling in a class. What is chosen is added to the booking's price, so it
 * is paid online, from credit or at the counter with the court, and refunded
 * with it; the desk sees it on the booking, ready for check-in. A pass pays
 * for court hours only, so a booking with extras is paid another way.
 */

export const MAX_QUANTITY = 20;
export const MAX_ADDONS = 20;

export type AddonKind = "rental" | "sale";

export interface Addon {
  id: number;
  venueId: number;
  name: string;
  kind: AddonKind;
  price: number;
  /** Rentals: how many there are. null: as many as asked for. */
  stock: number | null;
  sport: Sport | null;
  active: boolean;
  /** When offered for a time: how many are left then. null: no limit. */
  left?: number | null;
}

export interface Chosen {
  addonId: number;
  quantity: number;
}

export interface BookingAddon {
  addonId: number;
  name: string;
  kind: AddonKind;
  quantity: number;
  unitPrice: number;
}

interface AddonRow {
  id: number;
  venue_id: number;
  name: string;
  kind: AddonKind;
  price: number | string;
  stock: number | null;
  sport: Sport | null;
  active: number;
}

const toAddon = (r: AddonRow): Addon => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  kind: r.kind,
  price: Number(r.price),
  stock: r.stock,
  sport: r.sport,
  active: r.active === 1,
});

export async function listAddons(venueId: number, opts: { activeOnly?: boolean; sport?: Sport } = {}): Promise<Addon[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM venue_addons WHERE venue_id = ?${opts.activeOnly ? " AND active = 1" : ""}${
        opts.sport ? " AND (sport IS NULL OR sport = ?)" : ""
      } ORDER BY active DESC, kind, name, id`
    )
    .all(venueId, ...(opts.sport ? [opts.sport] : []))) as AddonRow[];
  return rows.map(toAddon);
}

export async function addonById(id: number): Promise<Addon | null> {
  const row = (await getDb().prepare("SELECT * FROM venue_addons WHERE id = ?").get(id)) as AddonRow | undefined;
  return row ? toAddon(row) : null;
}

export type AddonResult = { ok: true; value: Addon } | { ok: false; error: string };

export interface AddonInput {
  name: string;
  kind: AddonKind;
  price: number;
  stock?: number | null;
  sport?: Sport | null;
  active?: boolean;
}

function checkInput(input: AddonInput): string | null {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) return "Give it a name.";
  if (input.kind !== "rental" && input.kind !== "sale") return "Hire or sale?";
  if (!Number.isFinite(input.price) || input.price < 0 || input.price > 1000) return "Check the price.";
  if (input.stock !== undefined && input.stock !== null && (!Number.isInteger(input.stock) || input.stock < 1 || input.stock > 500))
    return "How many there are: 1 to 500, or leave it empty.";
  if (input.sport && !isKnownActivity(input.sport)) return "Unknown sport.";
  return null;
}

export async function createAddon(venueId: number, input: AddonInput): Promise<AddonResult> {
  const wrong = checkInput(input);
  if (wrong) return { ok: false, error: wrong };
  const { n } = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_addons WHERE venue_id = ? AND active = 1").get(venueId)) as { n: number };
  if (n >= MAX_ADDONS) return { ok: false, error: `${MAX_ADDONS} extras at most. Retire one first.` };
  const info = await getDb()
    .prepare("INSERT INTO venue_addons (venue_id, name, kind, price, stock, sport) VALUES (?, ?, ?, ?, ?, ?)")
    .run(venueId, input.name.trim(), input.kind, Math.round(input.price * 100) / 100, input.kind === "rental" ? (input.stock ?? null) : null, input.sport ?? null);
  return { ok: true, value: (await addonById(info.lastInsertRowid as number))! };
}

export async function updateAddon(id: number, input: AddonInput): Promise<AddonResult> {
  const wrong = checkInput(input);
  if (wrong) return { ok: false, error: wrong };
  const before = await addonById(id);
  if (!before) return { ok: false, error: "Not found." };
  if (!before.active && input.active !== false) {
    const { n } = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_addons WHERE venue_id = ? AND active = 1").get(before.venueId)) as { n: number };
    if (n >= MAX_ADDONS) return { ok: false, error: `${MAX_ADDONS} extras at most. Retire one first.` };
  }
  await getDb()
    .prepare("UPDATE venue_addons SET name = ?, kind = ?, price = ?, stock = ?, sport = ?, active = ? WHERE id = ?")
    .run(
      input.name.trim(),
      input.kind,
      Math.round(input.price * 100) / 100,
      input.kind === "rental" ? (input.stock ?? null) : null,
      input.sport ?? null,
      input.active === false ? 0 : 1,
      id
    );
  return { ok: true, value: (await addonById(id))! };
}

/** What staff typed, from a request body. */
export function readAddonInput(b: Record<string, unknown>): AddonInput {
  return {
    name: String(b.name ?? ""),
    kind: b.kind as AddonKind,
    price: b.price === "" || b.price === null ? NaN : Number(b.price),
    stock: b.stock === null || b.stock === undefined || b.stock === "" ? null : Number(b.stock),
    sport: typeof b.sport === "string" && b.sport !== "" ? (b.sport as Sport) : null,
    active: b.active !== false,
  };
}

/** The most of this add-on out on hire at any moment of a time on a day. */
async function rentedOut(addonId: number, date: string, span: Span, excludeBookingId?: number): Promise<number> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.start_min, b.end_min, ba.quantity FROM booking_addons ba JOIN bookings b ON b.id = ba.booking_id
        WHERE ba.addon_id = ? AND b.status = 'confirmed' AND b.date = ? AND b.start_min < ? AND b.end_min > ?
          AND b.id <> ?`
    )
    .all(addonId, date, span.end, span.start, excludeBookingId ?? 0)) as { start_min: number; end_min: number; quantity: number }[];
  const edges = rows
    .flatMap((r) => [[Math.max(r.start_min, span.start), r.quantity], [Math.min(r.end_min, span.end), -r.quantity]] as [number, number][])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let load = 0;
  let most = 0;
  for (const [, d] of edges) most = Math.max(most, (load += d));
  return most;
}

export async function offered(venueId: number, sport: Sport, date: string, span: Span | null): Promise<Addon[]> {
  const list = await listAddons(venueId, { activeOnly: true, sport });
  // No time chosen yet: what the venue has, before anything is out.
  for (const a of list) a.left = a.stock === null ? null : Math.max(0, a.stock - (span ? await rentedOut(a.id, date, span) : 0));
  return list;
}

export type ChooseResult = { ok: true; lines: BookingAddon[]; total: number } | Refusal;

function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(translator("en"), code, vars), code, ...(vars ? { vars } : {}) };
}

/** Check what was chosen against what is offered, and price it. */
export async function priceChoice(
  chosen: Chosen[],
  at: { venueId: number; sport: Sport; date: string; span: Span; excludeBookingId?: number }
): Promise<ChooseResult> {
  const lines: BookingAddon[] = [];
  const seen = new Set<number>();
  for (const c of chosen) {
    if (!Number.isInteger(c.addonId) || !Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > MAX_QUANTITY)
      return refuse("ADDON_QUANTITY", { max: MAX_QUANTITY });
    if (seen.has(c.addonId)) return refuse("ADDON_QUANTITY", { max: MAX_QUANTITY });
    seen.add(c.addonId);
    const addon = await addonById(c.addonId);
    if (!addon || !addon.active || addon.venueId !== at.venueId || (addon.sport !== null && addon.sport !== at.sport))
      return refuse("ADDON_NOT_OFFERED");
    if (addon.stock !== null) {
      const left = addon.stock - (await rentedOut(addon.id, at.date, at.span, at.excludeBookingId));
      if (c.quantity > left)
        return left <= 0
          ? refuse("ADDON_SOLD_OUT", { name: addon.name.toLowerCase() })
          : refuse("ADDON_FEW_LEFT", { n: left, name: addon.name.toLowerCase() });
    }
    lines.push({ addonId: addon.id, name: addon.name, kind: addon.kind, quantity: c.quantity, unitPrice: addon.price });
  }
  return { ok: true, lines, total: Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100 };
}

/**
 * Put the extras on a booking, checked again for its own day and hours, and
 * add them to what it costs: the lines and their total if they all went on;
 * otherwise why not, and the booking stands without any of them.
 */
export async function attachAddons(bookingId: number, chosen: Chosen[]): Promise<ChooseResult> {
  if (chosen.length === 0) return { ok: true, lines: [], total: 0 };
  const db = getDb();
  return db.transaction(async () => {
    const b = (await db
      .prepare(
        `SELECT b.id, b.date, b.start_min, b.end_min, c.venue_id, b.sport
           FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?`
      )
      .get(bookingId)) as { id: number; date: string; start_min: number; end_min: number; venue_id: number; sport: Sport } | undefined;
    if (!b) return refuse("BOOKING_NOT_FOUND");
    const priced = await priceChoice(chosen, { venueId: b.venue_id, sport: b.sport, date: b.date, span: { start: b.start_min, end: b.end_min }, excludeBookingId: b.id });
    if (!priced.ok) return priced;
    for (const l of priced.lines)
      await db
        .prepare("INSERT INTO booking_addons (booking_id, addon_id, name, kind, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)")
        .run(bookingId, l.addonId, l.name, l.kind, l.quantity, l.unitPrice);
    await db.prepare("UPDATE bookings SET total_price = total_price + ? WHERE id = ?").run(priced.total, bookingId);
    return priced;
  })();
}

/** What each of these bookings came with. */
export async function addonsFor(bookingIds: number[]): Promise<Map<number, BookingAddon[]>> {
  const out = new Map<number, BookingAddon[]>();
  if (bookingIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT booking_id, addon_id, name, kind, quantity, unit_price FROM booking_addons
        WHERE booking_id IN (${bookingIds.map(() => "?").join(",")}) ORDER BY id`
    )
    .all(...bookingIds)) as { booking_id: number; addon_id: number; name: string; kind: AddonKind; quantity: number; unit_price: number | string }[];
  for (const r of rows)
    out.set(r.booking_id, [
      ...(out.get(r.booking_id) ?? []),
      { addonId: r.addon_id, name: r.name, kind: r.kind, quantity: r.quantity, unitPrice: Number(r.unit_price) },
    ]);
  return out;
}

/** Whether a booking came with extras. */
export async function hasAddons(bookingId: number): Promise<boolean> {
  return !!(await getDb().prepare("SELECT 1 FROM booking_addons WHERE booking_id = ? LIMIT 1").get(bookingId));
}

/** `[{ addonId, quantity }]` from a request, or null if it is not that shape. */
export function readChosen(raw: unknown): Chosen[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ADDONS) return null;
  const out: Chosen[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown>;
    const addonId = Number(r?.addonId);
    const quantity = Number(r?.quantity);
    if (!Number.isInteger(addonId) || !Number.isInteger(quantity)) return null;
    if (quantity > 0) out.push({ addonId, quantity });
  }
  return out;
}
