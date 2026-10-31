import { getDb } from "../db";
import { applyPatch, emptyAnswers, readStored, type AnswerPatch, type GuideAnswers } from "./answer-schema";

export * from "./answer-schema";

/**
 * The operator's intent for one venue (migration 0261, `venue_guide`): the
 * answers to the discovery questions, the steps they said they reviewed, and
 * the suggestions they dismissed. Nothing about how the venue is configured
 * lives here; that is read from where it is saved (profile.ts).
 *
 * Every write moves `rev`. `saveAnswers` takes the revision the caller was
 * looking at and is refused, with the current state, if somebody saved since:
 * two people saving at once cannot overwrite each other unseen, and neither
 * answer is lost, because the one refused is told and saves again on top of
 * the other's. Acknowledging and dismissing add one entry each, atomically,
 * so they need no revision of their own.
 */

/** A step the manager said they had reviewed: recorded, attributed and shown as such, never inferred. */
export interface Acknowledgement {
  at: string;
  byAdminId: number | null;
  byName: string;
}

export interface GuideState {
  venueId: number;
  answers: GuideAnswers;
  acknowledged: Record<string, Acknowledgement>;
  dismissed: Record<string, { at: string }>;
  /** Moves on every write; 0 for a venue that has never saved anything. */
  rev: number;
  updatedAt: string | null;
}

export interface Actor {
  id: number | null;
  name: string;
}

interface Row {
  answers: string;
  acknowledged: string;
  dismissed: string;
  rev: number;
  updated_at: string;
}

const SELECT = "SELECT answers::text AS answers, acknowledged::text AS acknowledged, dismissed::text AS dismissed, rev, updated_at FROM venue_guide WHERE venue_id = ?";

function parse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toState(venueId: number, row: Row | undefined): GuideState {
  if (!row) return { venueId, answers: emptyAnswers(), acknowledged: {}, dismissed: {}, rev: 0, updatedAt: null };
  const ack: Record<string, Acknowledgement> = {};
  for (const [id, v] of Object.entries(parse<Record<string, unknown>>(row.acknowledged))) {
    if (!isRecord(v) || typeof v.at !== "string" || typeof v.byName !== "string") continue;
    ack[id] = { at: v.at, byAdminId: typeof v.byAdminId === "number" ? v.byAdminId : null, byName: v.byName };
  }
  const gone: Record<string, { at: string }> = {};
  for (const [id, v] of Object.entries(parse<Record<string, unknown>>(row.dismissed))) if (isRecord(v) && typeof v.at === "string") gone[id] = { at: v.at };
  return { venueId, answers: readStored(parse(row.answers)), acknowledged: ack, dismissed: gone, rev: Number(row.rev), updatedAt: row.updated_at };
}

/** The venue's intent as saved; empty (revision 0) for a venue that has saved none. */
export async function readGuide(venueId: number): Promise<GuideState> {
  return toState(venueId, (await getDb().prepare(SELECT).get(venueId)) as Row | undefined);
}

async function ensureRow(venueId: number): Promise<void> {
  await getDb().prepare("INSERT INTO venue_guide (venue_id) VALUES (?) ON CONFLICT (venue_id) DO NOTHING").run(venueId);
}

export type SaveResult = { ok: true; state: GuideState } | { ok: false; stale: true; state: GuideState };

/**
 * Put a patch of answers on the venue's answers, if `expectedRev` is the
 * revision they are at; else refuse, with the state as it now is. The patch
 * is already validated (`validatePatch`); a null takes an answer back.
 */
export async function saveAnswers(venueId: number, patch: AnswerPatch, expectedRev: number, by: Actor | null = null): Promise<SaveResult> {
  const db = getDb();
  return db.transaction(async (): Promise<SaveResult> => {
    await ensureRow(venueId);
    const row = (await db.prepare(SELECT).get(venueId)) as Row | undefined;
    const state = toState(venueId, row);
    if (state.rev !== expectedRev) return { ok: false, stale: true, state };
    const next = applyPatch(state.answers, patch);
    const done = await db
      .prepare("UPDATE venue_guide SET answers = ?::jsonb, rev = rev + 1, updated_at = datetime('now'), updated_by = ? WHERE venue_id = ? AND rev = ?")
      .run(JSON.stringify(next), by?.id ?? null, venueId, expectedRev);
    if (done.changes === 0) return { ok: false, stale: true, state: toState(venueId, (await db.prepare(SELECT).get(venueId)) as Row | undefined) };
    return { ok: true, state: toState(venueId, (await db.prepare(SELECT).get(venueId)) as Row | undefined) };
  })();
}

/** Step and suggestion ids are short words: nothing else is stored under a key. */
export const isGuideId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);

async function addEntry(venueId: number, column: "acknowledged" | "dismissed", id: string, entry: Record<string, unknown>, by: Actor | null): Promise<GuideState> {
  const db = getDb();
  return db.transaction(async () => {
    await ensureRow(venueId);
    await db
      .prepare(`UPDATE venue_guide SET ${column} = ${column} || ?::jsonb, rev = rev + 1, updated_at = datetime('now'), updated_by = ? WHERE venue_id = ?`)
      .run(JSON.stringify({ [id]: entry }), by?.id ?? null, venueId);
    return toState(venueId, (await db.prepare(SELECT).get(venueId)) as Row | undefined);
  })();
}

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Record that a manager reviewed a step, as themselves and when. Reviewing again records it again. */
export async function acknowledge(venueId: number, stepId: string, by: Actor): Promise<GuideState> {
  return addEntry(venueId, "acknowledged", stepId, { at: now(), byAdminId: by.id, byName: by.name.slice(0, 100) }, by);
}

/** Record that a suggestion was dismissed: it is not offered again. */
export async function dismiss(venueId: number, suggestionId: string, by: Actor | null = null): Promise<GuideState> {
  return addEntry(venueId, "dismissed", suggestionId, { at: now() }, by);
}

/**
 * Start a venue's intent from what a visitor chose in the public guide, if it
 * has none yet (`ON CONFLICT DO NOTHING`): used when an application opens the
 * venue. Never replaces answers a manager has saved.
 */
export async function seedFromFit(venueId: number, fit: GuideAnswers): Promise<void> {
  await getDb()
    .prepare("INSERT INTO venue_guide (venue_id, answers, rev, updated_at) VALUES (?, ?::jsonb, 1, datetime('now')) ON CONFLICT (venue_id) DO NOTHING")
    .run(venueId, JSON.stringify(fit));
}
