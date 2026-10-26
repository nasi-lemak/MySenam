import { DICTIONARIES, type Phrase } from "./i18n";
import { STAFF_DICTIONARIES, type StaffPhrase } from "./staff-i18n";
import { CONCESSION_PRESETS, isConcessionPreset, type ConcessionPreset } from "./concessions-shared";

/**
 * Is this a built-in concession's own text, word for word, as any staff
 * language or any customer language writes it? Server-only: it reads every
 * dictionary. `proof` left out compares the name alone.
 */
export function isPresetWords(preset: ConcessionPreset, name: string, proof?: string | null): boolean {
  const staff = Object.values(STAFF_DICTIONARIES).map((d) => [d[`con.preset.${preset}` as StaffPhrase], d[`con.proof.${preset}` as StaffPhrase]]);
  const customer = Object.values(DICTIONARIES).map((d) => [d[`pre.con.${preset}` as Phrase], d[`pre.con.${preset}.proof` as Phrase]]);
  return [...staff, ...customer].some(([n, p]) => n === name && (proof === undefined || proof === null || p === proof));
}

/** The built-in concession `preset` names, kept only while `name` and `proof` are its words (lib/concessions.ts `saveConcession`). */
export function unchangedPreset(preset: unknown, name: string, proof: string): ConcessionPreset | null {
  return isConcessionPreset(preset) && isPresetWords(preset, name, proof) ? preset : null;
}

/**
 * The built-in concession a booking was made at, for one booked before
 * bookings kept the key (migration 0122): only when the concession it was made
 * at is still, word for word, that preset (by its key, or by its name and
 * proof) and the booking carries the same name. Its words are then the
 * preset's own, not text the venue typed, so saying them in the reader's
 * language changes no meaning. Anything else stays as stored.
 */
export function derivedPreset(booking: {
  concessionName: string | null;
  concessionPreset: string | null;
  concession: { name: string; proof: string; preset: string | null } | null;
}): ConcessionPreset | null {
  if (isConcessionPreset(booking.concessionPreset)) return booking.concessionPreset;
  const c = booking.concession;
  if (!booking.concessionName || !c || c.name !== booking.concessionName) return null;
  if (isConcessionPreset(c.preset)) return isPresetWords(c.preset, booking.concessionName) ? c.preset : null;
  return CONCESSION_PRESETS.find((p) => isPresetWords(p, c.name, c.proof)) ?? null;
}
