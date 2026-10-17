import { baseUrl } from "./outbox";
import { siteName } from "./site";

/**
 * Where things are: the pin a venue drops on the map, where its address
 * leads, and how far apart those are.
 *
 * Addresses are looked up with Nominatim, OpenStreetMap's geocoder. The public
 * server is free and needs no key, and asks in return for no more than one
 * request a second and a User-Agent that says who is asking — both kept here.
 * An install expecting more than a handful of lookups a minute runs its own
 * Nominatim and points MYSENAM_GEOCODER at it; MYSENAM_GEOCODER=off looks
 * nothing up, and every check that needs a lookup then says it was not done.
 *
 * Nothing here decides anything. A lookup is evidence for the person
 * approving a venue, set beside the map; an address OpenStreetMap does not
 * know is common in a new taman, and not a sign of a fake.
 */

export interface Point {
  lat: number;
  lng: number;
}

const PUBLIC_NOMINATIM = "https://nominatim.openstreetmap.org";

/** Malaysia, roughly: Perlis to Sabah, Johor to the Thai border. */
const MALAYSIA = { south: 0.85, north: 7.4, west: 99.6, east: 119.3 };

export function inMalaysia(p: Point): boolean {
  return p.lat >= MALAYSIA.south && p.lat <= MALAYSIA.north && p.lng >= MALAYSIA.west && p.lng <= MALAYSIA.east;
}

/** A pin as it arrives from a form: two finite numbers, or nothing. */
export function readPoint(lat: unknown, lng: unknown): Point | null {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Six decimals is ten centimetres; anything finer is noise from a drag.
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

/** Metres between two points, along the ground. */
export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

/** "850 m" or "12.4 km". */
export function formatDistance(m: number): string {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

/** Short forms people write for the place names a map spells out. */
const AREA_ALIASES: Record<string, string> = {
  kl: "kuala lumpur",
  pj: "petaling jaya",
  jb: "johor bahru",
  kk: "kota kinabalu",
  ttdi: "taman tun dr ismail",
  "s'gor": "selangor",
};

const NOT_A_PLACE = new Set(["jalan", "taman", "bandar", "kampung", "lorong", "persiaran", "the", "and", "di"]);

/**
 * Whether the area somebody typed is named in what the map says is at their
 * pin — "Cheras" in "Taman Connaught, Cheras, Kuala Lumpur". Loose on
 * purpose: one place name in common is enough.
 */
export function areaMatches(area: string, place: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const where = ` ${norm(place)} `;
  const said = norm(area);
  if (AREA_ALIASES[said] && where.includes(` ${AREA_ALIASES[said]} `)) return true;
  return said
    .split(" ")
    .filter((w) => w.length >= 3 && !NOT_A_PLACE.has(w))
    .some((w) => where.includes(` ${w} `) || where.includes(` ${AREA_ALIASES[w] ?? w} `));
}

/** The geocoder to ask, or null when this install looks nothing up. */
function geocoder(): string | null {
  const setting = process.env.MYSENAM_GEOCODER?.trim();
  if (setting === "off") return null;
  return (setting || PUBLIC_NOMINATIM).replace(/\/+$/, "");
}

export function geocoderOn(): boolean {
  return geocoder() !== null;
}

// One request a second to the public server, from this process.
let nextSlot = 0;
async function takeTurn(url: string): Promise<void> {
  if (!url.startsWith(PUBLIC_NOMINATIM)) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1100;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

// The same address is looked up as the applicant types and again when they
// send the form; the answer will not have changed.
const cache = new Map<string, unknown>();
const CACHE_SIZE = 500;

async function ask(path: string, params: Record<string, string>): Promise<unknown> {
  const base = geocoder();
  if (!base) return null;
  const url = `${base}${path}?${new URLSearchParams({ format: "jsonv2", "accept-language": "en", ...params })}`;
  if (cache.has(url)) return cache.get(url);
  await takeTurn(url);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": `${siteName()} venue check (${baseUrl()})` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(url, body);
    return body;
  } catch (err) {
    console.error("[mysenam] address lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Where an address leads, in Malaysia, or null if the map does not know it. */
export async function findAddress(query: string): Promise<(Point & { label: string }) | null> {
  const q = query.trim().slice(0, 300);
  if (q.length < 3) return null;
  const found = await ask("/search", { q, countrycodes: "my", limit: "1" });
  const first = Array.isArray(found) ? (found[0] as { lat?: string; lon?: string; display_name?: string }) : null;
  if (!first?.lat || !first.lon) return null;
  const point = { lat: Number(first.lat), lng: Number(first.lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return { ...point, label: first.display_name ?? q };
}

/** What the map calls the place at a point: "Cheras, Kuala Lumpur, Malaysia". */
export async function placeAt(p: Point): Promise<string | null> {
  const found = (await ask("/reverse", { lat: String(p.lat), lon: String(p.lng), zoom: "16" })) as {
    display_name?: string;
  } | null;
  return found?.display_name ?? null;
}

/** For tests: forget earlier answers and the public server's queue. */
export function resetGeocoder(): void {
  cache.clear();
  nextSlot = 0;
}
