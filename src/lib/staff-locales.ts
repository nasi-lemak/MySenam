import { offeredLocales, type Locale } from "./i18n";

/**
 * Which languages the staff dashboard is in: English, Malay and Chinese, the
 * languages a venue's staff commonly work in (the owner's decision of
 * 24 October 2026; not Tamil). Apart from the dictionaries
 * (lib/staff-i18n) so the language switch on customers' pages does not carry
 * them.
 */
export const STAFF_LOCALES = ["en", "ms", "zh"] as const;
export type StaffLocale = (typeof STAFF_LOCALES)[number];

/** The staff languages this install offers: its own languages, less Tamil. The first is the default. */
export function staffLocales(): StaffLocale[] {
  const offered = offeredLocales().filter((l): l is StaffLocale => (STAFF_LOCALES as readonly string[]).includes(l));
  return offered.length > 0 ? offered : ["en"];
}

/** The dashboard's language for a visitor reading the site in `locale`: the same, if staff screens have it. */
export function staffLocale(locale: Locale): StaffLocale {
  const offered = staffLocales();
  return (offered as string[]).includes(locale) ? (locale as StaffLocale) : offered[0];
}
