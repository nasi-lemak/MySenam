import { BUILTIN_ACTIVITIES } from "../../activity-catalogue";
import { MAX_FIT_CHARS, normaliseFit, validatePatch, type GuideAnswers } from "../answer-schema";
import { BUSINESS_TYPE_IDS, isBusinessTypeId, isCatalogueActivity, type BusinessTypeId } from "../business-types";

/**
 * What a visitor chose in the public guide, and how it travels
 * (docs/features/venue-guide.md#the-public-guide).
 *
 * The choice lives in the address and nowhere else: `?types=a,b&activities=x`
 * for the guide, and `?fit=types:a,b~activities:x` for the application form,
 * which sends it with the application (`fit`, `normaliseFit`). Reading it
 * writes nothing. Unknown values are left out, never an error: an address
 * somebody typed, or one from before a business type was renamed, still
 * shows what it can.
 *
 * Browser-safe: no database.
 */

export interface Selection {
  types: BusinessTypeId[];
  /** Catalogue activity keys. */
  activities: string[];
}

/** What a page or a form receives of the address. */
export type Params = Record<string, string | string[] | undefined>;

const MAX_ACTIVITIES = 32;
const ACTIVITY_ORDER = BUILTIN_ACTIVITIES.map((a) => a.key);

export const emptySelection = (): Selection => ({ types: [], activities: [] });
export const isEmptySelection = (s: Selection): boolean => s.types.length === 0 && s.activities.length === 0;

/** Every value of a parameter, a repeated one (a form's checkboxes) and a comma list alike. */
function values(raw: string | string[] | undefined): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 64);
}

/** The choices that exist among these, once each, in the order the guide lists them. */
export function knownTypes(ids: readonly string[]): BusinessTypeId[] {
  const set = new Set(ids.filter(isBusinessTypeId));
  return BUSINESS_TYPE_IDS.filter((id) => set.has(id));
}

export function knownActivities(keys: readonly string[]): string[] {
  const set = new Set(keys.filter(isCatalogueActivity));
  return ACTIVITY_ORDER.filter((k) => set.has(k)).slice(0, MAX_ACTIVITIES);
}

/** The selection an address carries: `types` and `activities`, each a list; whatever is not a known choice is ignored. */
export function parseSelection(params: Params): Selection {
  return { types: knownTypes(values(params.types)), activities: knownActivities(values(params.activities)) };
}

/** The guide's own address for a selection: `/for-venues?types=a,b&activities=x`, short and readable. */
export function guideAddress(sel: Selection): string {
  const q = [sel.types.length ? `types=${sel.types.join(",")}` : "", sel.activities.length ? `activities=${sel.activities.join(",")}` : ""].filter(Boolean);
  return q.length ? `/for-venues?${q.join("&")}` : "/for-venues";
}

/**
 * The compact form the application form reads: `types:a,b~activities:x,y`.
 * Only characters a query string allows as they are, so the address stays
 * readable; nothing personal is ever in it.
 */
export function encodeFit(sel: Selection): string {
  return [sel.types.length ? `types:${sel.types.join(",")}` : "", sel.activities.length ? `activities:${sel.activities.join(",")}` : ""].filter(Boolean).join("~");
}

/** The application form's address for a selection: `/list-your-venue?fit=…`, or the bare form with no choice. */
export function applyAddress(sel: Selection): string {
  const fit = encodeFit(sel);
  return fit ? `/list-your-venue?fit=${fit}` : "/list-your-venue";
}

/**
 * The `fit` an application form reads from its address: the compact form, or
 * JSON of the `GuideAnswers` shape. Lenient the way the address is: a value
 * that does not exist is dropped, so an old link still works; what comes back
 * is something `normaliseFit` accepts (or null for no choice). Never throws.
 */
export function decodeFit(raw: string | null | undefined): GuideAnswers | null {
  if (!raw || raw.length > MAX_FIT_CHARS) return null;
  const text = raw.trim();
  const patch: Record<string, unknown> = {};
  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
    for (const [k, v] of Object.entries(json)) {
      if (k === "v") continue;
      // One answer at a time, so one that is not valid does not take the rest with it.
      if (validatePatch({ [k]: v }).ok && v !== null) patch[k] = v;
      else if (k === "types" && Array.isArray(v)) patch.types = knownTypes(v.filter((x): x is string => typeof x === "string"));
      else if (k === "activities" && Array.isArray(v)) patch.activities = knownActivities(v.filter((x): x is string => typeof x === "string"));
    }
  } else {
    for (const part of text.split("~")) {
      const [name, list = ""] = part.split(":");
      const items = list.split(",").map((s) => s.trim()).filter(Boolean);
      if (name === "types") patch.types = knownTypes(items);
      else if (name === "activities") patch.activities = knownActivities(items);
    }
  }
  for (const k of Object.keys(patch)) if (Array.isArray(patch[k]) && (patch[k] as unknown[]).length === 0) delete patch[k];
  const checked = normaliseFit(patch);
  return checked.ok ? checked.fit : null;
}

/** The selection inside a decoded `fit`, for showing it back. */
export function selectionOf(fit: GuideAnswers | null): Selection {
  return { types: knownTypes(fit?.types ?? []), activities: knownActivities(fit?.activities ?? []) };
}
