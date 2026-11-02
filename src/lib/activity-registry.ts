import {
  ACTIVITY_CATEGORIES,
  BUILTIN_ACTIVITIES,
  type ActivityCategory,
  type ActivityDefinition,
  type ActivityLocale,
} from "./activity-catalogue.ts";
import type { PolicySettings } from "./booking-rules";
import type { CourtFilter } from "./facilities";
import { region } from "./region.ts";

/**
 * The activity catalogue as this process knows it (ADR 0011): the built-ins
 * until the database has been read, then the `activities` table, built-ins
 * and operators' own alike. Lookups are synchronous so a label, an icon or a
 * sport's usual booking rules can be had anywhere: on the server it is kept
 * fresh by lib/activities.ts; in the browser the root layout hands the list
 * to the activity provider, which records it here before anything renders.
 *
 * Browser-safe: no database.
 */

export interface Activity extends ActivityDefinition {
  /** An operator's own: their business's, or (a venue in no business) their venue's. Both null: the platform's. */
  businessId: number | null;
  venueId: number | null;
  builtin: boolean;
  /** Offered for new courts and in search. Retired ones still name what was booked. */
  active: boolean;
  position: number;
}

const BUILTINS: Activity[] = BUILTIN_ACTIVITIES.map((a, i) => ({ ...a, businessId: null, venueId: null, builtin: true, active: true, position: i }));

let list: Activity[] = BUILTINS;
let byKey = new Map(list.map((a) => [a.key, a]));

/** Replace what is known (the database's list, or the server's handed to the browser). */
export function setActivities(next: Activity[]): void {
  list = order(next);
  byKey = new Map(list.map((a) => [a.key, a]));
}

/** In the order customers are offered them: by category, then each one's place. */
function order(xs: Activity[]): Activity[] {
  const cat = (c: ActivityCategory) => ACTIVITY_CATEGORIES.indexOf(c);
  return [...xs].sort((a, b) => cat(a.category) - cat(b.category) || a.position - b.position || a.key.localeCompare(b.key));
}

/** Every activity known, retired ones included. */
export function allActivities(): Activity[] {
  return list;
}

/** The activities on offer, in order. */
export function activeActivities(): Activity[] {
  return list.filter((a) => a.active);
}

/** Every activity key on offer, in order. */
export function activityKeys(): string[] {
  return activeActivities().map((a) => a.key);
}

export function isKnownActivity(key: unknown): key is string {
  return typeof key === "string" && byKey.has(key);
}

/** Known and still offered: what a new court, class or search may name. */
export function isActiveActivity(key: unknown): key is string {
  return typeof key === "string" && byKey.get(key)?.active === true;
}

/**
 * The activity, or a stand-in for a key this process has not heard of yet
 * (an operator's own, added on another instance a moment ago): named after
 * its key, booked like any court.
 */
export function activity(key: string): Activity {
  const known = byKey.get(key);
  if (known) return known;
  const name = key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return {
    key,
    category: "specialist",
    icon: "generic/court",
    names: { en: name },
    aliases: [],
    template: { model: "exclusive", noun: "court", capacity: 1, count: 1, perPlayer: false, maxPlayers: null, setting: null, signOff: false },
    policy: {},
    surfaced: false,
    supervised: false,
    filters: ["indoor", "outdoor"],
    support: "basic",
    supportNote: null,
    country: {},
    businessId: null,
    venueId: null,
    builtin: false,
    active: true,
    position: 9999,
  };
}

function country(): string {
  try {
    return region().country;
  } catch {
    return "MY";
  }
}

/** Its name in a language, as this country calls it. */
export function activityName(key: string, locale: string = "en", where: string = country()): string {
  const a = activity(key);
  const l = locale as ActivityLocale;
  const local = a.country[where]?.names;
  return local?.[l] ?? a.names[l] ?? local?.en ?? a.names.en;
}

/** Its picture as stored: a glyph name, or an operator's emoji from before glyphs (components/Glyph.tsx draws either). */
export function activityIcon(key: string): string {
  return activity(key).icon;
}

/**
 * Its usual booking rules, beneath every venue's own (lib/booking-rules.ts).
 * An activity whose template asks for a sign-off (a belay check, a range
 * briefing) asks for one unless a venue says otherwise.
 */
export function activityPolicy(key: string): PolicySettings {
  const a = activity(key);
  return a.template.signOff && a.policy.signOff === undefined ? { ...a.policy, signOff: true } : a.policy;
}

/** The court filters worth offering for it in search, as this country sees them. */
export function activityFilters(key: string, where: string = country()): CourtFilter[] {
  const a = activity(key);
  return a.country[where]?.filters ?? a.filters;
}

/** Every word it may be searched by: its names in each language, and its aliases here. */
export function activityTerms(key: string, where: string = country()): string[] {
  const a = activity(key);
  const local = a.country[where];
  return [
    ...Object.values(a.names),
    ...Object.values(local?.names ?? {}),
    ...a.aliases,
    ...(local?.aliases ?? []),
    a.key.replace(/_/g, " "),
  ].filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The activities a typed word finds ("ping pong", "SUP", "羽毛球"), best
 * first: a name or alias that is the word, then one that starts with it, then
 * one that contains it.
 */
export function findActivities(query: string, where: string = country()): string[] {
  const q = fold(query);
  if (q === "") return [];
  const scored: [string, number][] = [];
  for (const a of activeActivities()) {
    let best = 0;
    for (const term of activityTerms(a.key, where).map(fold)) {
      if (term === q) best = Math.max(best, 3);
      else if (term.startsWith(q) || term.split(" ").some((w) => w.startsWith(q))) best = Math.max(best, 2);
      else if (term.includes(q)) best = Math.max(best, 1);
    }
    if (best > 0) scored.push([a.key, best]);
  }
  return scored.sort((x, y) => y[1] - x[1]).map(([k]) => k);
}

/** How long a game or session usually is, in minutes: what search asks for when it is picked. */
export function usualMinutes(key: string): number {
  return activity(key).policy.defaultLength ?? 60;
}
