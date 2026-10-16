import { getDb } from "./db";
import { baseUrl } from "./outbox";
import { getVenue } from "./store";

/**
 * A venue's own website on the marketplace: abc.com showing ABC's venues,
 * under ABC's name and colour, on the same server as everything else.
 *
 * This changes what the public pages show, not who can see what. The
 * bookings, payments, admin and credit behind them already belong to venues,
 * and are untouched; a storefront is a window onto some of them. A business
 * that wants its customers and data apart from everybody else's gets its own
 * install instead (see the README).
 *
 * Which storefront a request is for comes from the hostname it was made to,
 * matched exactly against the ones the platform owner registered. Anything
 * else is the marketplace itself — so a made-up Host header can only ever
 * reach a storefront that exists, and shows only what it would show anyway.
 */

export interface Storefront {
  id: number;
  hostname: string;
  name: string;
  tagline: string | null;
  /** #rrggbb, dark enough for white text. Null keeps the marketplace's. */
  accentColor: string | null;
  logoUrl: string | null;
  venueIds: number[];
}

interface Row {
  id: number;
  hostname: string;
  name: string;
  tagline: string | null;
  accent_color: string | null;
  logo_url: string | null;
}

function toStorefront(r: Row): Storefront {
  const venueIds = (
    getDb()
      .prepare("SELECT venue_id FROM storefront_venues WHERE storefront_id = ? ORDER BY venue_id")
      .all(r.id) as { venue_id: number }[]
  ).map((v) => v.venue_id);
  return {
    id: r.id,
    hostname: r.hostname,
    name: r.name,
    tagline: r.tagline,
    accentColor: r.accent_color,
    logoUrl: r.logo_url,
    venueIds,
  };
}

/**
 * A hostname as it is stored and compared: lower case, no port, no trailing
 * dot, and no `www.` — so www.abc.com and abc.com are the same storefront.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase().split(",")[0].trim();
  // An IPv6 literal keeps its colons; anything else loses its port.
  host = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return host || null;
}

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function storefrontForHost(raw: string | null | undefined): Storefront | null {
  const host = normalizeHost(raw);
  if (!host) return null;
  const row = getDb().prepare("SELECT * FROM storefronts WHERE hostname = ?").get(host) as Row | undefined;
  return row ? toStorefront(row) : null;
}

/**
 * The hostname a request was made to. The Host header, unless the install
 * sits behind a proxy that rewrites it and is trusted to pass the original in
 * X-Forwarded-Host (MYSENAM_TRUST_FORWARDED_HOST=on). Render passes Host
 * through as it is.
 */
export function requestHost(headers: { get(name: string): string | null }): string | null {
  if (process.env.MYSENAM_TRUST_FORWARDED_HOST === "on") {
    const forwarded = headers.get("x-forwarded-host");
    if (forwarded) return forwarded;
  }
  return headers.get("host");
}

/** The storefront an API request was made on, if any. */
export function storefrontForRequest(req: { headers: { get(name: string): string | null } }): Storefront | null {
  return storefrontForHost(requestHost(req.headers));
}

/** The storefront a page is being rendered for, if any. */
export async function currentStorefront(): Promise<Storefront | null> {
  const { headers } = await import("next/headers");
  return storefrontForHost(requestHost(await headers()));
}

/** Does this storefront show this venue? No storefront shows every venue. */
export function shows(storefront: Storefront | null, venueId: number): boolean {
  return storefront === null || storefront.venueIds.includes(venueId);
}

/**
 * Where a customer of this venue should be sent back to: its storefront, if
 * it has one, so a link in a confirmation opens the site they booked on.
 */
export function venueBaseUrl(venueId: number): string {
  const row = getDb()
    .prepare(`
      SELECT s.hostname FROM storefronts s
        JOIN storefront_venues sv ON sv.storefront_id = s.id
       WHERE sv.venue_id = ? ORDER BY s.id LIMIT 1
    `)
    .get(venueId) as { hostname: string } | undefined;
  return row ? `https://${row.hostname}` : baseUrl();
}

// ------------------------------------------------------------ the colour

function channel(hex: string, i: number): number {
  const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast of white text on this colour. */
export function contrastWithWhite(hex: string): number {
  const l = 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  return 1.05 / (l + 0.05);
}

/**
 * The marketplace's teal, swapped for the storefront's colour.
 *
 * Every teal in the interface is a Tailwind theme variable, so redefining the
 * scale recolours the whole site — buttons, links, highlights — without
 * touching a component. The given colour is the 600 that buttons use; the
 * rest are mixed from it toward white and black.
 */
export function accentCss(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "";
  const toWhite = (pct: number) => `color-mix(in oklab, ${hex} ${pct}%, white)`;
  const toBlack = (pct: number) => `color-mix(in oklab, ${hex} ${pct}%, black)`;
  const scale: Record<number, string> = {
    50: toWhite(8),
    100: toWhite(16),
    200: toWhite(32),
    300: toWhite(52),
    400: toWhite(74),
    500: toWhite(88),
    600: hex,
    700: toBlack(82),
    800: toBlack(68),
    900: toBlack(56),
  };
  return `:root{${Object.entries(scale)
    .map(([step, value]) => `--color-teal-${step}:${value};`)
    .join("")}--brand:${hex};--brand-dark:${scale[700]};}`;
}

// ------------------------------------------------------------ managing them

export function listStorefronts(): Storefront[] {
  return (getDb().prepare("SELECT * FROM storefronts ORDER BY hostname").all() as Row[]).map(toStorefront);
}

export type SaveResult = { ok: true; storefront: Storefront } | { ok: false; error: string };

export function saveStorefront(input: {
  id?: number;
  hostname: string;
  name: string;
  tagline?: string | null;
  accentColor?: string | null;
  logoUrl?: string | null;
  venueIds: number[];
}): SaveResult {
  // Whatever got pasted — https://www.abc.com/booking — comes down to its domain.
  const hostname = normalizeHost(input.hostname.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0]);
  if (!hostname || !HOSTNAME.test(hostname))
    return { ok: false, error: "Give the domain alone, like abcbadminton.com." };
  const own = normalizeHost(new URL(baseUrl()).host);
  if (hostname === own) return { ok: false, error: "That is the marketplace's own address." };
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "The name is 2 to 60 characters." };
  const tagline = input.tagline?.trim() || null;
  if (tagline && tagline.length > 140) return { ok: false, error: "The tagline is at most 140 characters." };

  const accent = input.accentColor?.trim().toLowerCase() || null;
  if (accent) {
    if (!/^#[0-9a-f]{6}$/.test(accent)) return { ok: false, error: "The colour is a hex code like #1d4ed8." };
    if (contrastWithWhite(accent) < 4.5)
      return {
        ok: false,
        error: "That colour is too light for white writing on buttons to be readable. Pick a darker shade.",
      };
  }
  const logoUrl = input.logoUrl?.trim() || null;
  if (logoUrl && (!/^https:\/\/[^\s"'<>]+$/.test(logoUrl) || logoUrl.length > 500))
    return { ok: false, error: "The logo is an https:// address of an image." };

  const venueIds = [...new Set(input.venueIds)];
  if (venueIds.length === 0) return { ok: false, error: "A storefront shows at least one venue." };
  for (const id of venueIds) if (!getVenue(id)) return { ok: false, error: `Venue ${id} not found.` };

  const db = getDb();
  const clash = db.prepare("SELECT id FROM storefronts WHERE hostname = ?").get(hostname) as
    | { id: number }
    | undefined;
  if (clash && clash.id !== input.id) return { ok: false, error: `${hostname} is already a storefront.` };

  let id = input.id ?? 0;
  try {
    db.transaction(() => {
      if (input.id) {
        const done = db
          .prepare(
            "UPDATE storefronts SET hostname = ?, name = ?, tagline = ?, accent_color = ?, logo_url = ? WHERE id = ?"
          )
          .run(hostname, name, tagline, accent, logoUrl, input.id);
        if (done.changes === 0) throw new Error("NOT_FOUND");
      } else {
        id = db
          .prepare("INSERT INTO storefronts (hostname, name, tagline, accent_color, logo_url) VALUES (?, ?, ?, ?, ?)")
          .run(hostname, name, tagline, accent, logoUrl).lastInsertRowid as number;
      }
      db.prepare("DELETE FROM storefront_venues WHERE storefront_id = ?").run(id);
      const link = db.prepare("INSERT INTO storefront_venues (storefront_id, venue_id) VALUES (?, ?)");
      for (const venueId of venueIds) link.run(id, venueId);
    })();
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_FOUND") return { ok: false, error: "Storefront not found." };
    throw err;
  }

  const row = db.prepare("SELECT * FROM storefronts WHERE id = ?").get(id) as Row | undefined;
  if (!row) return { ok: false, error: "Storefront not found." };
  return { ok: true, storefront: toStorefront(row) };
}

export function deleteStorefront(id: number): boolean {
  return getDb().prepare("DELETE FROM storefronts WHERE id = ?").run(id).changes === 1;
}
