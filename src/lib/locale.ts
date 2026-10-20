import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, Locale, offeredLocales, translator, T } from "./i18n";
import { siteName } from "./site";
import { currentStorefront } from "./storefront";

/** Which language this request is in. */
export async function currentLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  const offered = offeredLocales();
  // A language this install does not offer (a cookie from another country's
  // site, say) falls back to the install's own.
  return isLocale(value) && offered.includes(value) ? value : (offered[0] ?? DEFAULT_LOCALE);
}

/** What the site is called on this request: the storefront's name on one, else SITE_NAME. */
export async function currentSiteName(): Promise<string> {
  return (await currentStorefront())?.name ?? siteName();
}

/** The lookup for this request, for a server component. */
export async function serverT(): Promise<T> {
  return translator(await currentLocale(), await currentSiteName());
}
