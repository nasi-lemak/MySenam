import { fill, phraseVars, translateError, translator, type RefusalBody, type T, type Vars } from "../i18n";
import { STAFF_LOCALES, staffLocale, staffLocales, type StaffLocale } from "../staff-locales";
import { region, retellTimes } from "../region";
import { siteName } from "../site";
import common from "./common";
import approvals from "./approvals";
import server from "./server";
import bookings from "./bookings";
import competitions from "./competitions";
import teams from "./teams";
import courts from "./courts";
import credit from "./credit";
import platform from "./platform";
import reports from "./reports";
import settings from "./settings";
import shell from "./shell";
import venues from "./venues";
import alerts from "./alerts";
import guide from "./guide";
import guideSetup from "./guide-setup";
import guidePlaybook from "./guide-playbook";
import guideHelp from "./guide-help";
import { REFUSALS as REFUSALS_1 } from "./refusals-1";
import { REFUSALS as REFUSALS_2 } from "./refusals-2";
import { sayWith, type StaffText } from "../staff-text";

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

export const STAFF_AREAS = { common, approvals, server, bookings, competitions, teams, courts, credit, platform, reports, settings, shell, venues, alerts, guide, guideSetup, guidePlaybook, guideHelp };

const EN = {
  ...common.en,
  ...approvals.en,
  ...server.en,
  ...bookings.en,
  ...competitions.en,
  ...teams.en,
  ...courts.en,
  ...credit.en,
  ...platform.en,
  ...reports.en,
  ...settings.en,
  ...shell.en,
  ...venues.en,
  ...alerts.en,
  ...guide.en,
  ...guideSetup.en,
  ...guidePlaybook.en,
  ...guideHelp.en,
};

export type StaffPhrase = keyof typeof EN;

const merged = (l: "ms" | "zh"): Record<StaffPhrase, string> => ({
  ...common[l],
  ...approvals[l],
  ...server[l],
  ...bookings[l],
  ...competitions[l],
  ...teams[l],
  ...courts[l],
  ...credit[l],
  ...platform[l],
  ...reports[l],
  ...settings[l],
  ...shell[l],
  ...venues[l],
  ...alerts[l],
  ...guide[l],
  ...guideSetup[l],
  ...guidePlaybook[l],
  ...guideHelp[l],
});

export const STAFF_DICTIONARIES: Record<StaffLocale, Record<StaffPhrase, string>> = { en: EN, ms: merged("ms"), zh: merged("zh") };

export interface StaffT {
  (phrase: StaffPhrase, vars?: Vars): string;
  /** The `_one` or `_other` form, with `{n}` already filled in. */
  plural(stem: string, n: number, vars?: Vars): string;
  /** A refusal from the server, in this language where it carries a code or a known sentence; else as sent. */
  err(body: string | RefusalBody | null | undefined, fallback?: string): string;
  /** Text the server composed (lib/staff-text.ts), in this language; the fallback (the server's English, or what was stored) when there is none. */
  say(text: StaffText | null | undefined, fallback?: string): string;
  /** A phrase named at run time (a gateway's, a template's), or null when the dictionaries have none. */
  known(phrase: string, vars?: Vars): string | null;
  /** The customer dictionary in the same language, for what customers also see (activity names, refusals). */
  customer: T;
  locale: StaffLocale;
}

/** English refusals as sent, in Malay and Chinese; those with {0}, {1}… as patterns, tried in turn. */
export const STAFF_REFUSALS: Record<string, { ms: string; zh: string }> = { ...REFUSALS_1, ...REFUSALS_2 };
const exactRefusals = new Map<string, { ms: string; zh: string }>();
const patternRefusals: { re: RegExp; said: { ms: string; zh: string } }[] = [];
for (const [en, said] of Object.entries(STAFF_REFUSALS)) {
  if (!/\{\d+\}/.test(en)) exactRefusals.set(en, said);
  else
    patternRefusals.push({
      re: new RegExp(`^${en.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)")}$`),
      said,
    });
}

/** A refusal the server sent in English, in Malay or Chinese if it is in the map; null if not. */
export function staffRefusal(sentence: string, locale: StaffLocale): string | null {
  if (locale === "en" || !sentence) return null;
  const exact = exactRefusals.get(sentence);
  if (exact) return exact[locale];
  for (const { re, said } of patternRefusals) {
    const m = sentence.match(re);
    // What it carried is put back as it was, but for its times, which are said as the language writes them.
    if (m) return said[locale].replace(/\{(\d+)\}/g, (_, i: string) => retellTimes(m[Number(i) + 1] ?? "", locale));
  }
  return null;
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
    const sent = typeof body === "string" ? body : (body?.error ?? "");
    const said = translateError(customer, body);
    // Not translated by its code or the customer map: the staff map, then as sent.
    const staff = said === sent ? staffRefusal(sent, locale) : null;
    return staff ?? (said || (fallback ?? t("c.failed")));
  };
  t.say = (text, fallback = "") => (text ? sayWith(text, (key, vars) => t(key, vars), locale) : fallback);
  t.known = (phrase, vars) => (phrase in dict ? t(phrase as StaffPhrase, vars) : null);
  t.customer = customer;
  t.locale = locale;
  cache.set(key, t);
  return t;
}
