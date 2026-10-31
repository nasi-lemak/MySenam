import { BUSINESS_TYPE_IDS, isCatalogueActivity, isBusinessTypeId, type BusinessTypeId } from "./business-types";

/**
 * What a manager can tell the setup journey about their business: the
 * discovery questions' answers, as data (docs/features/venue-guide.md#discovery-answers).
 *
 * Intent only. A fact the venue's saved configuration shows is never asked
 * (the profile says it); these are the things no saved state can show yet
 * (what the venue means to do) and the choices that decide which steps the
 * journey leads through. Versioned (`v`), validated (unknown keys and values
 * are refused, lists are bounded), and carried unchanged from the public
 * guide's choices (`fit`) into the venue's own answers.
 *
 * Browser-safe: no database.
 */

export const ANSWERS_VERSION = 1;

/** What customers do at the venue. */
export const CUSTOMER_DOES = ["reserve", "classes", "memberships", "hire"] as const;
/** How many facilities or resources: one; two to six; seven to twenty; more. */
export const RESOURCE_BANDS = ["one", "few", "several", "many"] as const;
export const BRANCH_ANSWERS = ["one", "several"] as const;
/** Somebody always behind the counter; for part of the day; nobody (customers let themselves in). */
export const STAFFING_ANSWERS = ["staffed", "partial", "unattended"] as const;
export const CHANNEL_ANSWERS = ["online", "counter"] as const;
export const MEMBERSHIP_ANSWERS = ["memberships", "passes"] as const;
export const AUDIENCE_ANSWERS = ["public", "members", "both"] as const;

export interface GuideAnswers {
  v: typeof ANSWERS_VERSION;
  /** The kinds of business (business-types.ts). */
  types?: BusinessTypeId[];
  /** Catalogue activity keys. */
  activities?: string[];
  customersDo?: (typeof CUSTOMER_DOES)[number][];
  resources?: (typeof RESOURCE_BANDS)[number];
  branches?: (typeof BRANCH_ANSWERS)[number];
  staffing?: (typeof STAFFING_ANSWERS)[number];
  channels?: (typeof CHANNEL_ANSWERS)[number][];
  /** Sells memberships, passes, both or neither (an empty list: answered, neither). */
  memberships?: (typeof MEMBERSHIP_ANSWERS)[number][];
  coaching?: boolean;
  /** Takes bookings for children. */
  children?: boolean;
  audience?: (typeof AUDIENCE_ANSWERS)[number];
  /** Wants to run tournaments or leagues: until they say so, a venue is not led through scoring (the setup journey's question). */
  competitions?: boolean;
  /** Wants to offer discounts (student or senior prices, promo codes): until they say so, none are set up. */
  discounts?: boolean;
}

/** A change to answers: a key set to a value, or to null to take its answer back. */
export type AnswerPatch = { [K in keyof Omit<GuideAnswers, "v">]?: GuideAnswers[K] | null };

export const ANSWER_KEYS = [
  "types",
  "activities",
  "customersDo",
  "resources",
  "branches",
  "staffing",
  "channels",
  "memberships",
  "coaching",
  "children",
  "audience",
  "competitions",
  "discounts",
] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];

export const emptyAnswers = (): GuideAnswers => ({ v: ANSWERS_VERSION });

const MAX_ACTIVITIES = 32;

type Check = (value: unknown) => { ok: true; value: unknown } | { ok: false; error: string };

const choice = <T extends string>(allowed: readonly T[], what: string): Check => (value) =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? { ok: true, value } : { ok: false, error: `${what} is not one of the choices.` };

const choices = <T extends string>(allowed: readonly T[], what: string, max = allowed.length): Check => (value) => {
  if (!Array.isArray(value) || value.length > max) return { ok: false, error: `${what} must be a short list of choices.` };
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) return { ok: false, error: `${what} has a choice that is not offered.` };
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: out };
};

const CHECKS: Record<AnswerKey, Check> = {
  types: choices(BUSINESS_TYPE_IDS, "The business types", BUSINESS_TYPE_IDS.length),
  activities: (value) => {
    if (!Array.isArray(value) || value.length > MAX_ACTIVITIES) return { ok: false, error: "The activities must be a short list." };
    const out: string[] = [];
    for (const v of value) {
      if (!isCatalogueActivity(v)) return { ok: false, error: "That activity is not one MySenam knows." };
      if (!out.includes(v)) out.push(v);
    }
    return { ok: true, value: out };
  },
  customersDo: choices(CUSTOMER_DOES, "What customers do"),
  resources: choice(RESOURCE_BANDS, "The number of facilities"),
  branches: choice(BRANCH_ANSWERS, "The number of locations"),
  staffing: choice(STAFFING_ANSWERS, "How the venue is staffed"),
  channels: choices(CHANNEL_ANSWERS, "How customers book"),
  memberships: choices(MEMBERSHIP_ANSWERS, "Memberships and passes"),
  coaching: (value) => (typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Coaching is yes or no." }),
  children: (value) => (typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Children is yes or no." }),
  audience: choice(AUDIENCE_ANSWERS, "Who the venue is for"),
  competitions: (value) => (typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Competitions is yes or no." }),
  discounts: (value) => (typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Discounts is yes or no." }),
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A patch as a client sent it, checked: only known keys, each a value its
 * question allows, or null. Refuses rather than dropping: a typo in a key is
 * the caller's to hear about.
 */
export function validatePatch(input: unknown): { ok: true; patch: AnswerPatch } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "Answers must be an object." };
  const patch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!(ANSWER_KEYS as readonly string[]).includes(key)) return { ok: false, error: `There is no question called ${key.slice(0, 40)}.` };
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    const checked = CHECKS[key as AnswerKey](raw);
    if (!checked.ok) return checked;
    patch[key] = checked.value;
  }
  return { ok: true, patch: patch as AnswerPatch };
}

/** Answers with a patch put on: a null takes an answer back, and nothing else is touched. */
export function applyPatch(answers: GuideAnswers, patch: AnswerPatch): GuideAnswers {
  const next: Record<string, unknown> = { ...answers, v: ANSWERS_VERSION };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as unknown as GuideAnswers;
}

/**
 * Stored answers read defensively: whatever is in the database, what comes
 * back is valid answers (an unknown or invalid key is left out, never thrown
 * over), so a screen reading an old row cannot break on it.
 */
export function readStored(raw: unknown): GuideAnswers {
  const out = emptyAnswers();
  if (!isObject(raw)) return out;
  for (const key of ANSWER_KEYS) {
    if (!(key in raw)) continue;
    const checked = CHECKS[key](raw[key]);
    if (checked.ok) (out as unknown as Record<string, unknown>)[key] = checked.value;
  }
  return out;
}

/** The most a stored or applied `fit` may weigh, in characters of JSON. */
export const MAX_FIT_CHARS = 2000;

/**
 * What a visitor chose in the public guide, as an application carries it
 * (`venue_applications.fit`): business-type ids and activity keys that exist
 * (and any other discovery answer), bounded in size. Absent or null is fine
 * (no choice); anything else that is not valid is refused, not dropped.
 */
export function normaliseFit(raw: unknown): { ok: true; fit: GuideAnswers | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, fit: null };
  if (!isObject(raw)) return { ok: false, error: "The business choice must be an object." };
  const { v, ...rest } = raw;
  if (v !== undefined && v !== ANSWERS_VERSION) return { ok: false, error: "That business choice is from a version this site does not know." };
  if (JSON.stringify(rest).length > MAX_FIT_CHARS) return { ok: false, error: "The business choice is too large." };
  const checked = validatePatch(rest);
  if (!checked.ok) return checked;
  if (Object.values(checked.patch).some((x) => x === null)) return { ok: false, error: "A business choice has no empty answers." };
  const fit = applyPatch(emptyAnswers(), checked.patch);
  return { ok: true, fit: Object.keys(fit).length > 1 ? fit : null };
}

export { isBusinessTypeId };
