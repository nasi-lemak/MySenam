import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, Locale, offeredLocales, translator, T } from "./i18n";
import { LINK_LOCALE_HEADER } from "./link-locale";
import { siteName } from "./site";
import { currentStorefront } from "./storefront";

/**
 * Which language this request is in: the one the person chose (the cookie
 * the language switch sets), else the language of the message whose link
 * they followed (lib/link-locale.ts), else the install's first.
 */
export async function currentLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  const offered = offeredLocales();
  // A language this install does not offer (a cookie from another country's
  // site, say) falls back to the install's own.
  if (isLocale(value) && offered.includes(value)) return value;
  const linked = await linkLocale();
  return isLocale(linked) && offered.includes(linked) ? linked : (offered[0] ?? DEFAULT_LOCALE);
}

/** The language a message's link carried, as the middleware checked it; null with none (or outside a request). */
async function linkLocale(): Promise<string | null> {
  try {
    return (await headers()).get(LINK_LOCALE_HEADER);
  } catch {
    return null;
  }
}

/** What the site is called on this request: the storefront's name on one, else SITE_NAME. */
export async function currentSiteName(): Promise<string> {
  return (await currentStorefront())?.name ?? siteName();
}

/** The lookup for this request, for a server component. */
export async function serverT(): Promise<T> {
  return translator(await currentLocale(), await currentSiteName());
}
