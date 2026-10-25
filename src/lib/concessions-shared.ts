import type { Phrase, T } from "./i18n";

/**
 * The built-in concessions a venue can start from, shared by the page and the
 * server (lib/concessions.ts). One used unchanged is kept by its key, so each
 * customer reads its name and proof in their own language; one whose text
 * staff changed is the venue's own, shown as typed.
 */
export const CONCESSION_PRESETS = ["student", "senior", "child", "oku"] as const;
export type ConcessionPreset = (typeof CONCESSION_PRESETS)[number];

export function isConcessionPreset(value: unknown): value is ConcessionPreset {
  return typeof value === "string" && (CONCESSION_PRESETS as readonly string[]).includes(value);
}

/** A concession's name and what to bring, as this reader sees them. */
export function concessionWords(
  t: T,
  c: { name: string; proof?: string; preset?: string | null }
): { name: string; proof: string } {
  if (!isConcessionPreset(c.preset)) return { name: c.name, proof: c.proof ?? "" };
  return { name: t(`pre.con.${c.preset}` as Phrase), proof: t(`pre.con.${c.preset}.proof` as Phrase) };
}
