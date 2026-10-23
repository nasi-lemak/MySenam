import {
  ACTIVITY_CATEGORIES,
  BUILTIN_ACTIVITIES,
  RESOURCE_MODELS,
  RESOURCE_NOUNS,
  type ActivityCategory,
  type ActivityDefinition,
  type ActivityNames,
  type ActivityTemplate,
  type ResourceModel,
  type ResourceNoun,
} from "./activity-catalogue.ts";
import { allActivities, isActiveActivity, isKnownActivity, setActivities, type Activity } from "./activity-registry.ts";

/**
 * The activity catalogue in the database (ADR 0011, migration 0092): the
 * platform's built-ins, written from src/lib/activity-catalogue.ts on every
 * start so a release can add or correct one without a migration, and each
 * operator's own beside them. This module keeps the process's registry
 * (lib/activity-registry.ts) in step with the table.
 *
 * Built-ins belong to the code: what it says of them is written over the
 * table on every start, except whether they are offered (`active`), which
 * the platform owner may change. Operators' own are theirs to edit.
 */

/** Anything that runs SQL with $1 placeholders: the migration's connection, or the app's. */
export interface ActivityRunner {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const REFRESH_MS = 60_000;
let loadedAt = 0;

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Write the built-ins into the table: inserted where missing, brought up to date where present. */
export async function syncBuiltinActivities(db: ActivityRunner): Promise<void> {
  for (const [i, a] of BUILTIN_ACTIVITIES.entries()) {
    await db.query(
      `INSERT INTO activities (key, builtin, category, icon, names, aliases, template, policy, surfaced, supervised, filters, support, support_note, country, position)
       VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (key) DO UPDATE SET
         builtin = true, business_id = NULL, venue_id = NULL, category = EXCLUDED.category, icon = EXCLUDED.icon,
         names = EXCLUDED.names, aliases = EXCLUDED.aliases, template = EXCLUDED.template, policy = EXCLUDED.policy,
         surfaced = EXCLUDED.surfaced, supervised = EXCLUDED.supervised, filters = EXCLUDED.filters,
         support = EXCLUDED.support, support_note = EXCLUDED.support_note, country = EXCLUDED.country,
         position = EXCLUDED.position, updated_at = datetime('now')
       WHERE (activities.names, activities.aliases, activities.template, activities.policy, activities.support, activities.support_note,
              activities.country, activities.category, activities.icon, activities.filters, activities.position,
              activities.surfaced, activities.supervised, activities.builtin)
             IS DISTINCT FROM
             (EXCLUDED.names, EXCLUDED.aliases, EXCLUDED.template, EXCLUDED.policy, EXCLUDED.support, EXCLUDED.support_note,
              EXCLUDED.country, EXCLUDED.category, EXCLUDED.icon, EXCLUDED.filters, EXCLUDED.position,
              EXCLUDED.surfaced, EXCLUDED.supervised, true)`,
      [
        a.key,
        a.category,
        a.icon,
        json(a.names),
        json(a.aliases),
        json(a.template),
        json(a.policy),
        a.surfaced,
        a.supervised,
        json(a.filters),
        a.support,
        a.supportNote,
        json(a.country),
        i,
      ]
    );
  }
}

function parse<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toActivity(r: Record<string, unknown>): Activity {
  return {
    key: String(r.key),
    businessId: r.business_id === null || r.business_id === undefined ? null : Number(r.business_id),
    venueId: r.venue_id === null || r.venue_id === undefined ? null : Number(r.venue_id),
    builtin: r.builtin === true,
    category: r.category as ActivityCategory,
    icon: String(r.icon),
    names: parse<ActivityNames>(r.names, { en: String(r.key) }),
    aliases: parse<string[]>(r.aliases, []),
    template: parse<ActivityTemplate>(r.template, BUILTIN_ACTIVITIES[0].template),
    policy: parse(r.policy, {}),
    surfaced: r.surfaced === true,
    supervised: r.supervised === true,
    filters: parse(r.filters, []),
    support: r.support as Activity["support"],
    supportNote: (r.support_note as string | null) ?? null,
    country: parse(r.country, {}),
    position: Number(r.position),
    active: r.active === true,
  };
}

/** Read the table into the registry. */
export async function loadActivities(db: ActivityRunner): Promise<Activity[]> {
  const rows = (await db.query("SELECT * FROM activities", [])).rows;
  const list = rows.map(toActivity);
  setActivities(list);
  loadedAt = Date.now();
  return list;
}

/** On start: the built-ins written, and the whole catalogue read. */
export async function syncActivities(db: ActivityRunner): Promise<void> {
  await syncBuiltinActivities(db);
  await loadActivities(db);
}

async function appRunner(): Promise<ActivityRunner> {
  const { getDb } = await import("./db.ts");
  const db = getDb();
  return {
    async query(sql, params) {
      // $1… to ? for the app's statements.
      const rows = (await db.prepare(sql.replace(/\$\d+/g, "?")).all(...params)) as Record<string, unknown>[];
      return { rows };
    },
  };
}

/**
 * The catalogue, at most a minute old: activities another instance added are
 * seen within the minute, and this instance's own at once.
 */
export async function catalogue(): Promise<Activity[]> {
  if (Date.now() - loadedAt > REFRESH_MS) await loadActivities(await appRunner());
  return allActivities();
}

/** Is this an activity that may be named now (a new court, a pass, a search)? */
export async function isActivity(key: unknown): Promise<boolean> {
  if (isActiveActivity(key)) return true;
  if (typeof key !== "string") return false;
  // Perhaps added a moment ago elsewhere.
  if (!isKnownActivity(key)) await loadActivities(await appRunner());
  return isActiveActivity(key);
}

// ------------------------------------------------------------ operators' own

/** Who is asking: the platform owner, or the operator of a venue (in a business or not). */
export interface ActivityOwner {
  businessId: number | null;
  venueId: number | null;
  platform: boolean;
}

/** May this operator put this activity on their courts, classes and passes? */
export function mayUseActivity(a: Pick<Activity, "businessId" | "venueId">, venue: { id: number; businessId: number | null }): boolean {
  if (a.businessId === null && a.venueId === null) return true;
  return (a.businessId !== null && a.businessId === venue.businessId) || (a.venueId !== null && a.venueId === venue.id);
}

/** The activities a venue may offer: the platform's and its own business's (or its own). */
export async function activitiesForVenue(venue: { id: number; businessId: number | null }): Promise<Activity[]> {
  return (await catalogue()).filter((a) => a.active && mayUseActivity(a, venue));
}

/** May this venue offer this activity: active, and the platform's or its own business's (or its own). */
export async function venueMayOffer(venueId: number, sport: string): Promise<boolean> {
  const db = await appRunner();
  const row = (await db.query("SELECT id, business_id FROM venues WHERE id = $1", [venueId])).rows[0];
  if (!row) return false;
  const venue = { id: Number(row.id), businessId: row.business_id === null ? null : Number(row.business_id) };
  if (!(await isActivity(sport))) return false;
  return mayUseActivity(allActivities().find((a) => a.key === sport)!, venue);
}

export interface ActivityInput {
  names: Partial<ActivityNames>;
  category: string;
  icon?: string;
  aliases?: string[];
  model: string;
  noun: string;
  capacity?: number;
  perPlayer?: boolean;
  maxPlayers?: number | null;
}

const MAX_NAME = 40;

/** A key from its English name: "Sky Yoga" → sky_yoga, sky_yoga_2 if taken. */
async function freshKey(db: ActivityRunner, name: string): Promise<string> {
  let base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  if (!/^[a-z]/.test(base)) base = `activity_${base}`.replace(/_+$/, "");
  if (base.length < 2) base = "activity";
  for (let n = 1; ; n++) {
    const key = n === 1 ? base : `${base}_${n}`;
    const taken = (await db.query("SELECT 1 FROM activities WHERE key = $1", [key])).rows.length > 0;
    if (!taken) return key;
  }
}

function readInput(input: ActivityInput): { ok: true; value: Omit<ActivityDefinition, "key"> } | { ok: false; error: string } {
  const en = typeof input.names?.en === "string" ? input.names.en.trim() : "";
  if (en.length < 2 || en.length > MAX_NAME) return { ok: false, error: `Give it a name in English, 2 to ${MAX_NAME} characters.` };
  const names: ActivityNames = { en };
  for (const l of ["ms", "zh", "ta"] as const) {
    const v = input.names?.[l];
    if (typeof v === "string" && v.trim() !== "") {
      if (v.trim().length > MAX_NAME) return { ok: false, error: `Names are up to ${MAX_NAME} characters.` };
      names[l] = v.trim();
    }
  }
  if (!(ACTIVITY_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, error: "Choose a category." };
  if (!(RESOURCE_MODELS as readonly string[]).includes(input.model)) return { ok: false, error: "Choose how it is booked." };
  if (!(RESOURCE_NOUNS as readonly string[]).includes(input.noun)) return { ok: false, error: "Choose what one of its resources is called." };
  const model = input.model as ResourceModel;
  const shared = model === "shared" || model === "class" || model === "hire";
  const capacity = input.capacity ?? (shared ? 20 : 1);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) return { ok: false, error: "Places are 1 to 500." };
  if (!shared && capacity !== 1) return { ok: false, error: "A resource booked whole has one place." };
  const maxPlayers = input.maxPlayers ?? null;
  if (maxPlayers !== null && (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 50))
    return { ok: false, error: "At most 1 to 50 in one booking." };
  const aliases = (input.aliases ?? [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "" && x.length <= MAX_NAME)
    .slice(0, 12);
  const icon = typeof input.icon === "string" && input.icon.trim() !== "" ? [...input.icon.trim()].slice(0, 2).join("") : "📍";
  return {
    ok: true,
    value: {
      category: input.category as ActivityCategory,
      icon,
      names,
      aliases,
      template: {
        model,
        noun: input.noun as ResourceNoun,
        capacity,
        count: model === "lanes" ? 4 : 1,
        perPlayer: input.perPlayer === true,
        maxPlayers,
        setting: null,
        signOff: false,
      },
      policy: {},
      surfaced: false,
      supervised: false,
      filters: ["indoor", "outdoor"],
      // An operator's own is bookable as any resource is; nothing is known of what else it needs.
      support: "basic",
      supportNote: "An operator's own activity: booked with the engine's resources and rules.",
      country: {},
    },
  };
}

/** A new activity of an operator's own (or, for the platform owner, of the platform's). */
export async function createActivity(input: ActivityInput, owner: ActivityOwner): Promise<{ ok: true; activity: Activity } | { ok: false; error: string }> {
  const read = readInput(input);
  if (!read.ok) return read;
  const db = await appRunner();
  // One name once per owner: "Yoga" is the platform's already.
  const lower = read.value.names.en.toLowerCase();
  const clash = (await catalogue()).find(
    (a) =>
      a.active &&
      (a.businessId === null && a.venueId === null
        ? true
        : (owner.businessId !== null && a.businessId === owner.businessId) || (owner.venueId !== null && a.venueId === owner.venueId)) &&
      Object.values(a.names).some((n) => typeof n === "string" && n.toLowerCase() === lower)
  );
  if (clash) return { ok: false, error: `${clash.names.en} is already in the list.` };
  const key = await freshKey(db, read.value.names.en);
  const v = read.value;
  await db.query(
    `INSERT INTO activities (key, business_id, venue_id, builtin, category, icon, names, aliases, template, policy, surfaced, supervised, filters, support, support_note, country)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      key,
      owner.platform ? null : owner.businessId,
      owner.platform || owner.businessId !== null ? null : owner.venueId,
      v.category,
      v.icon,
      json(v.names),
      json(v.aliases),
      json(v.template),
      json(v.policy),
      v.surfaced,
      v.supervised,
      json(v.filters),
      v.support,
      v.supportNote,
      json(v.country),
    ]
  );
  await loadActivities(db);
  return { ok: true, activity: allActivities().find((a) => a.key === key)! };
}

/** Change an operator's own activity, or retire it (still names what was booked, offered no more). */
export async function updateActivity(
  key: string,
  input: Partial<ActivityInput> & { active?: boolean },
  owner: ActivityOwner
): Promise<{ ok: true; activity: Activity } | { ok: false; error: string }> {
  const current = (await catalogue()).find((a) => a.key === key);
  if (!current) return { ok: false, error: "Activity not found." };
  const own = owner.platform || mayUseActivity(current, { id: owner.venueId ?? -1, businessId: owner.businessId });
  const theirs = current.businessId !== null || current.venueId !== null;
  // Operators edit only their own; the platform owner may also retire a built-in.
  if (!own || (!theirs && !owner.platform)) return { ok: false, error: "Only its owner can change that activity." };
  const db = await appRunner();
  if (current.builtin) {
    if (input.active === undefined) return { ok: false, error: "A built-in activity is changed in the code; it can only be offered or not." };
    await db.query("UPDATE activities SET active = $1, updated_at = datetime('now') WHERE key = $2", [input.active === true, key]);
    await loadActivities(db);
    return { ok: true, activity: allActivities().find((a) => a.key === key)! };
  }
  const read = readInput({
    names: { ...current.names, ...(input.names ?? {}) },
    category: input.category ?? current.category,
    icon: input.icon ?? current.icon,
    aliases: input.aliases ?? current.aliases,
    model: input.model ?? current.template.model,
    noun: input.noun ?? current.template.noun,
    capacity: input.capacity ?? current.template.capacity,
    perPlayer: input.perPlayer ?? current.template.perPlayer,
    maxPlayers: input.maxPlayers === undefined ? current.template.maxPlayers : input.maxPlayers,
  });
  if (!read.ok) return read;
  const v = read.value;
  await db.query(
    `UPDATE activities SET category = $1, icon = $2, names = $3, aliases = $4, template = $5, active = $6, updated_at = datetime('now') WHERE key = $7`,
    [v.category, v.icon, json(v.names), json(v.aliases), json(v.template), input.active ?? current.active, key]
  );
  await loadActivities(db);
  return { ok: true, activity: allActivities().find((a) => a.key === key)! };
}
