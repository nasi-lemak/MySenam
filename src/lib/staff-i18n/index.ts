import { fill, phraseVars, translateError, translator, type RefusalBody, type T, type Vars } from "../i18n";
import { STAFF_LOCALES, staffLocale, staffLocales, type StaffLocale } from "../staff-locales";
import { region } from "../region";
import { siteName } from "../site";
import common from "./common";
import bookings from "./bookings";
import competitions from "./competitions";
import courts from "./courts";
import credit from "./credit";
import platform from "./platform";
import reports from "./reports";
import settings from "./settings";
import shell from "./shell";
import venues from "./venues";

/**
 * The staff dashboard's own dictionaries: English, Malay and Chinese, the
 * languages a venue's staff commonly work in (the owner's decision of
 * 24 October 2026; not Tamil). Kept apart from the customer dictionaries
 * (lib/i18n.ts) so customers' pages do not carry the dashboard's thousands of
 * phrases, and split by area so each area's file can be worked on alone.
 *
 * Each area's file gives English and the same keys in Malay and Chinese; the
 * types refuse a missing key, and tests/staff-i18n.test.ts a placeholder that
 * differs or a key used by two areas.
 */
export { STAFF_LOCALES, staffLocale, staffLocales, type StaffLocale };

export const STAFF_AREAS = { common, bookings, competitions, courts, credit, platform, reports, settings, shell, venues };

const EN = {
  ...common.en,
  ...bookings.en,
  ...competitions.en,
  ...courts.en,
  ...credit.en,
  ...platform.en,
  ...reports.en,
  ...settings.en,
  ...shell.en,
  ...venues.en,
};

export type StaffPhrase = keyof typeof EN;

const merged = (l: "ms" | "zh"): Record<StaffPhrase, string> => ({
  ...common[l],
  ...bookings[l],
  ...competitions[l],
  ...courts[l],
  ...credit[l],
  ...platform[l],
  ...reports[l],
  ...settings[l],
  ...shell[l],
  ...venues[l],
});

export const STAFF_DICTIONARIES: Record<StaffLocale, Record<StaffPhrase, string>> = { en: EN, ms: merged("ms"), zh: merged("zh") };

export interface StaffT {
  (phrase: StaffPhrase, vars?: Vars): string;
  /** The `_one` or `_other` form, with `{n}` already filled in. */
  plural(stem: string, n: number, vars?: Vars): string;
  /** A refusal from the server, in this language where it carries a code or a known sentence; else as sent. */
  err(body: string | RefusalBody | null | undefined, fallback?: string): string;
  /** The customer dictionary in the same language, for what customers also see (activity names, refusals). */
  customer: T;
  locale: StaffLocale;
}

// One object per language and site, so a `t` in a hook's dependencies stays the same.
const cache = new Map<string, StaffT>();

export function staffTranslator(locale: StaffLocale, site: string = siteName()): StaffT {
  const key = `${locale}\u0000${site}`;
  const known = cache.get(key);
  if (known) return known;
  const customer = translator(locale, site);
  const dict = STAFF_DICTIONARIES[locale] ?? EN;
  const base: Vars = { ...phraseVars(locale, site), qr: region().qrName };
  const t = ((phrase: StaffPhrase, vars?: Vars) => fill(dict[phrase] ?? EN[phrase] ?? String(phrase), { ...base, ...vars })) as StaffT;
  t.plural = (stem: string, n: number, vars?: Vars) => {
    const key = `${stem}_${n === 1 ? "one" : "other"}` as StaffPhrase;
    return fill(dict[key] ?? EN[key] ?? stem, { ...base, n, ...vars });
  };
  t.err = (body, fallback) => {
    const said = translateError(customer, body);
    return said || (fallback ?? t("c.failed"));
  };
  t.customer = customer;
  t.locale = locale;
  cache.set(key, t);
  return t;
}
