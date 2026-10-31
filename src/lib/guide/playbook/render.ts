import { activityName } from "../../activity-registry";
import { minuteClock, money, shortDate } from "../../region";
import { isWords } from "./dsl";
import type { Block, GuideLink, Playbook, PhraseKey, Value, Words } from "./types";

/**
 * Saying a playbook: phrases and typed values into text, in the reader's
 * language, with the dashboard's own helpers (money, times and dates as
 * lib/region.ts writes them; an activity by its name in the language; what
 * the venue typed as typed). Browser-safe and pure: the screen, the print
 * view, the search index and the tests all read the same words through here.
 */

/** A staff-dictionary lookup: `t` of `useStaffT()` or `staffTranslator(locale)`. */
export type Say = (phrase: PhraseKey, vars?: Record<string, string | number>) => string;

export interface Speaker {
  t: Say;
  /** The reader's staff language: en, ms or zh. */
  locale: string;
}

/** A value as the text it is said as. */
export function sayValue(s: Speaker, v: Value): string {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (isWords(v)) return say(s, v);
  if ("money" in v) return money(v.money);
  if ("clock" in v) return minuteClock(v.clock, s.locale);
  if ("date" in v) return shortDate(v.date, s.locale);
  if ("iso" in v) return v.iso;
  if ("activity" in v) return activityName(v.activity, s.locale);
  return v.list.map((x) => sayValue(s, x)).join(s.t("gp.list.join"));
}

/** A phrase with its values said. */
export function say(s: Speaker, words: Words): string {
  if (!words.vars) return s.t(words.key);
  const vars: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(words.vars)) vars[name] = sayValue(s, v);
  return s.t(words.key, vars);
}

/** A link's label, said. */
export const sayLink = (s: Speaker, link: GuideLink): string => say(s, link.label);

/** Every piece of readable text in a block, in order: what a search looks through and a test reads. */
export function blockText(s: Speaker, block: Block): string[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [say(s, block.text)];
    case "callout":
      return [...(block.title ? [say(s, block.title)] : []), say(s, block.text)];
    case "steps":
      return block.items.flatMap((i) => [say(s, i.text), ...(i.link ? [sayLink(s, i.link)] : [])]);
    case "facts":
      return block.items.flatMap((i) => [say(s, i.label), say(s, i.value), ...(i.link ? [sayLink(s, i.link)] : [])]);
    case "link":
      return [sayLink(s, block.link)];
    case "table":
      return [...block.head.map((h) => say(s, h)), ...block.rows.flatMap((r) => r.map((c) => say(s, c)))];
  }
}

/** Every link in a block. */
export function blockLinks(block: Block): GuideLink[] {
  switch (block.type) {
    case "steps":
      return block.items.flatMap((i) => (i.link ? [i.link] : []));
    case "facts":
      return block.items.flatMap((i) => (i.link ? [i.link] : []));
    case "link":
      return [block.link];
    default:
      return [];
  }
}

/** Every link in a playbook, for the tests that hold each to the real role rules. */
export function playbookLinks(book: Playbook): GuideLink[] {
  return book.sections.flatMap((sec) => sec.blocks.flatMap(blockLinks));
}

/** The whole guide as plain text, one line per piece: its search index, and what a golden test reads. */
export function playbookText(s: Speaker, book: Playbook): string[] {
  return [
    ...book.summary.map((x) => say(s, x)),
    ...book.sections.flatMap((sec) => [say(s, sec.title), ...sec.blocks.flatMap((b) => blockText(s, b))]),
  ];
}
