// With its extension, as the backup scripts load lib/offsite.ts under plain Node.
import server from "./staff-i18n/server.ts";

/**
 * Text MySenam composes on the server for a staff screen, kept translatable:
 * a phrase of the staff dictionaries' server area (`srv.` keys,
 * lib/staff-i18n/server.ts) with its values, which the screen says in the
 * staff member's language (`t.say`, lib/staff-i18n). A value may itself be a
 * phrase, said first, or a list of phrases, said and joined.
 *
 * The English the server has always sent is the same phrase said in English
 * (`englishOf`), so it is written once and cannot drift from what the screens
 * show. What people typed, providers' and gateways' errors and raw exception
 * text stay values, never phrases.
 */
export type ServerPhrase = keyof typeof server.en;
export type StaffValue = string | number | StaffText | StaffText[];
export interface StaffText {
  key: ServerPhrase;
  vars?: Record<string, StaffValue>;
}

export const said = (key: ServerPhrase, vars?: Record<string, StaffValue>): StaffText => (vars ? { key, vars } : { key });

/** Whether a stored or sent value is one of these. */
export function isStaffText(v: unknown): v is StaffText {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as StaffText).key === "string" && (v as StaffText).key.startsWith("srv.");
}

/** Said with a lookup: values that are phrases first, lists joined with the lookup's comma. */
export function sayWith(text: StaffText, phrase: (key: ServerPhrase, vars: Record<string, string | number>) => string): string {
  const vars: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(text.vars ?? {}))
    vars[name] = Array.isArray(v) ? v.map((x) => sayWith(x, phrase)).join(phrase("srv.list.comma", {})) : isStaffText(v) ? sayWith(v, phrase) : v;
  return phrase(text.key, vars);
}

const fillIn = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));

/** The English, as the server sends it in emails, logs and its English fields. */
export function englishOf(text: StaffText): string {
  return sayWith(text, (key, vars) => fillIn(server.en[key] ?? key, vars));
}

/** Values joined pairwise by a two-place phrase ("{a} and {b}", "{a} {b}"): "A and B and C"; nothing for none. */
export function joinSaid(items: StaffValue[], key: ServerPhrase): StaffValue {
  if (items.length === 0) return "";
  return items.slice(1).reduce<StaffValue>((a, b) => said(key, { a, b }), items[0]);
}

/** A length of time as `formatLength` (lib/interval.ts) writes it ("1 hour 30 minutes"), as a phrase. */
export function lengthText(minutes: number): StaffText {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = said(h === 1 ? "srv.len.h_one" : "srv.len.h_other", { n: h });
  if (m === 0) return h === 0 ? said("srv.len.m", { n: 0 }) : hours;
  return h === 0 ? said("srv.len.m", { n: m }) : said("srv.len.hm", { hours, m });
}

/** Text stored with its phrase beside it: the English for its column, the phrase (JSON) for the one next to it. */
export function withPhrase(text: StaffText): [string, string] {
  return [englishOf(text), JSON.stringify(text)];
}

/** A stored phrase read back (JSON), or null when there is none or it is not one. */
export function readStaffText(raw: string | null | undefined): StaffText | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return isStaffText(v) ? v : null;
  } catch {
    return null;
  }
}
