/**
 * A link in a message opens in the language the message was written in.
 *
 * The site's language is a cookie (lib/i18n.ts `LOCALE_COOKIE`), set only
 * when somebody chooses one with the language switch. A link in an email or
 * WhatsApp message is opened in whatever browser the person reads it in,
 * often one that has never been to the site, so on its own it would open in
 * the install's first language, not the language of the message.
 *
 * So a link MySenam sends carries the message's language as a fixed
 * parameter (`?lang=ms`), one of the four languages and nothing else, added
 * to an address MySenam built itself: never a URL taken from a request, so
 * it cannot be turned into a redirect anywhere. The middleware reads the
 * parameter, checks it against the four, and hands it to the page on a
 * request header of its own (any such header the browser sent is dropped);
 * `currentLocale` (lib/locale.ts) uses it only where the person has not
 * chosen a language: an explicit choice (the cookie) wins. Nothing is
 * stored: the next page without the parameter is in their own language
 * again. The link still identifies exactly what it did (its token, its
 * expiry), since the parameter is added beside them, not in place of them.
 *
 * Kept apart from lib/i18n.ts so the middleware does not load the
 * dictionaries; `tests/link-locale.test.ts` checks the two lists agree.
 */

export const LINK_LANG_PARAM = "lang";

/** The request header the middleware hands a link's language to the page on. */
export const LINK_LOCALE_HEADER = "x-mysenam-link-locale";

/** The languages a link may carry: lib/i18n.ts `LOCALES`. */
export const LINK_LOCALES = ["en", "ms", "zh", "ta"] as const;

export function isLinkLocale(value: unknown): value is (typeof LINK_LOCALES)[number] {
  return typeof value === "string" && (LINK_LOCALES as readonly string[]).includes(value);
}

/**
 * `url`, an address MySenam built, with the language `locale` as its `lang`
 * parameter, before any `#fragment`; unchanged for anything not one of the
 * four languages, or a URL that already names one.
 */
export function linkIn(url: string, locale: string): string {
  if (!isLinkLocale(locale)) return url;
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  const query = base.indexOf("?");
  if (query !== -1 && new URLSearchParams(base.slice(query + 1)).has(LINK_LANG_PARAM)) return url;
  return `${base}${query === -1 ? "?" : "&"}${LINK_LANG_PARAM}=${locale}${fragment}`;
}

/** The language a request's own `lang` parameter names, if it is one of the four; else null. For the middleware. */
export function linkLocaleOf(params: URLSearchParams): string | null {
  const value = params.get(LINK_LANG_PARAM);
  return isLinkLocale(value) ? value : null;
}
