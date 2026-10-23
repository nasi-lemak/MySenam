import type { Court, Sport } from "./types";

/**
 * What a venue offers besides its courts, and what each court is like — the
 * things players compare venues by.
 *
 * Everything here is from a fixed list rather than free text, so that two
 * venues can be put side by side and searched by it. What the system already
 * knows — how many courts, the cheapest hour, the opening hours — is worked
 * out from the courts and never typed in, so it cannot go stale.
 *
 * Kept free of the database, so pages in the browser can use it too.
 */

export const AMENITIES = [
  "showers",
  "changing_rooms",
  "lockers",
  "toilets",
  "free_parking",
  "paid_parking",
  "transit",
  "surau",
  "drinking_water",
  "cafe",
  "pro_shop",
  "stringing",
  "equipment_rental",
  "coaching",
  "wheelchair",
  "first_aid",
  "wifi",
  "seating",
] as const;
export type Amenity = (typeof AMENITIES)[number];

export const AMENITY_ICONS: Record<Amenity, string> = {
  showers: "🚿",
  changing_rooms: "👕",
  lockers: "🔐",
  toilets: "🚻",
  free_parking: "🅿️",
  paid_parking: "🅿️",
  transit: "🚇",
  surau: "🕌",
  drinking_water: "🚰",
  cafe: "☕",
  pro_shop: "🛍️",
  stringing: "🧵",
  equipment_rental: "🎒",
  coaching: "🧑‍🏫",
  wheelchair: "♿",
  first_aid: "⛑️",
  wifi: "📶",
  seating: "🪑",
};

/** What most players look for first, shown on search cards in this order. */
export const HEADLINE_AMENITIES: Amenity[] = ["showers", "free_parking", "paid_parking", "surau", "transit"];

export function isAmenity(x: unknown): x is Amenity {
  return typeof x === "string" && (AMENITIES as readonly string[]).includes(x);
}

/** A venue's list as given: known ones only, once each, in the list's order. */
export function cleanAmenities(input: unknown): Amenity[] {
  const given = new Set(Array.isArray(input) ? input.filter(isAmenity) : []);
  return AMENITIES.filter((a) => given.has(a));
}

export const SURFACES = ["wood", "mat", "hard", "clay", "turf", "tiles", "concrete"] as const;
export type Surface = (typeof SURFACES)[number];

export function isSurface(x: unknown): x is Surface {
  return typeof x === "string" && (SURFACES as readonly string[]).includes(x);
}

export type Setting = "indoor" | "outdoor";

/** What a court is like. null where the venue has not said. */
export interface CourtFeatures {
  setting: Setting | null;
  aircon: boolean;
  floodlit: boolean;
  surface: Surface | null;
}

/** What players can filter courts by. */
export const COURT_FILTERS = ["indoor", "outdoor", "aircon", "floodlit"] as const;
export type CourtFilter = (typeof COURT_FILTERS)[number];

export function isCourtFilter(x: unknown): x is CourtFilter {
  return typeof x === "string" && (COURT_FILTERS as readonly string[]).includes(x);
}

/** Does this court have it? */
export function courtHas(court: CourtFeatures, f: CourtFilter): boolean {
  if (f === "indoor" || f === "outdoor") return court.setting === f;
  return court[f];
}

/** The same, in SQL against courts `c`, for searching. Fixed text: nothing from the request goes in. */
export function courtFilterSql(f: CourtFilter): string {
  if (f === "indoor" || f === "outdoor") return `c.setting = '${f}'`;
  return `c.${f} = 1`;
}

/** Filters searched as one: parking is parking, free or paid. */
export const AMENITY_FILTERS = ["showers", "parking", "surau", "transit", "changing_rooms", "wheelchair"] as const;
export type AmenityFilter = (typeof AMENITY_FILTERS)[number];

export function isAmenityFilter(x: unknown): x is AmenityFilter {
  return typeof x === "string" && (AMENITY_FILTERS as readonly string[]).includes(x);
}

/** The amenities that satisfy a filter. */
export function amenitiesFor(f: AmenityFilter): Amenity[] {
  return f === "parking" ? ["free_parking", "paid_parking"] : [f];
}

/** `?has=showers,aircon` into the filters it names; anything else is ignored. */
export function readFacilityFilters(raw: string | null | undefined): { amenities: AmenityFilter[]; courts: CourtFilter[] } {
  const parts = (raw ?? "").split(",").map((p) => p.trim());
  return {
    amenities: [...new Set(parts.filter(isAmenityFilter))],
    courts: [...new Set(parts.filter(isCourtFilter))],
  };
}

export interface SportSummary {
  sport: Sport;
  courts: number;
  /** The cheapest hour, off-peak, public rate. */
  from: number;
  indoor: number;
  outdoor: number;
  aircon: number;
  floodlit: number;
  surfaces: Surface[];
}

/**
 * Worked out from the courts themselves: per sport, how many, from what
 * price, and what they are like.
 */
export function summariseCourts(courts: (Pick<Court, "sport" | "offPeakRate"> & CourtFeatures)[]): SportSummary[] {
  const bySport = new Map<Sport, SportSummary>();
  for (const c of courts) {
    const s =
      bySport.get(c.sport) ??
      { sport: c.sport, courts: 0, from: Infinity, indoor: 0, outdoor: 0, aircon: 0, floodlit: 0, surfaces: [] };
    s.courts++;
    s.from = Math.min(s.from, Number(c.offPeakRate));
    if (c.setting === "indoor") s.indoor++;
    if (c.setting === "outdoor") s.outdoor++;
    if (c.aircon) s.aircon++;
    if (c.floodlit) s.floodlit++;
    if (c.surface && !s.surfaces.includes(c.surface)) s.surfaces.push(c.surface);
    bySport.set(c.sport, s);
  }
  return [...bySport.values()];
}

/** The filters offered as chips, most asked-for first: `?has=aircon,showers`. */
export const FILTER_CHIPS = ["aircon", "indoor", "showers", "parking", "surau", "transit"] as const;
export type FilterChip = (typeof FILTER_CHIPS)[number];

export const FILTER_ICONS: Record<FilterChip | "outdoor" | "floodlit", string> = {
  aircon: "❄️",
  indoor: "🏠",
  outdoor: "🌤️",
  floodlit: "💡",
  showers: AMENITY_ICONS.showers,
  parking: AMENITY_ICONS.free_parking,
  surau: AMENITY_ICONS.surau,
  transit: AMENITY_ICONS.transit,
};

export type Highlight = { kind: "court"; key: "aircon" | "indoor" | "floodlit" } | { kind: "amenity"; key: Amenity };

/**
 * The few things worth a place on a search card: air-con or floodlights on
 * the courts asked about, then what players look for first. At most four.
 */
export function highlights(courts: CourtFeatures[], amenities: Amenity[]): Highlight[] {
  const out: Highlight[] = [];
  if (courts.some((c) => c.aircon)) out.push({ kind: "court", key: "aircon" });
  else if (courts.length > 0 && courts.every((c) => c.setting === "indoor")) out.push({ kind: "court", key: "indoor" });
  if (courts.some((c) => c.floodlit)) out.push({ kind: "court", key: "floodlit" });
  for (const a of HEADLINE_AMENITIES) if (amenities.includes(a)) out.push({ kind: "amenity", key: a });
  return out.slice(0, 4);
}

export function highlightIcon(h: Highlight): string {
  return h.kind === "court" ? FILTER_ICONS[h.key] : AMENITY_ICONS[h.key];
}
