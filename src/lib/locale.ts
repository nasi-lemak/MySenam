import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, Locale, translator, T } from "./i18n";
import { siteName } from "./site";
import { currentStorefront } from "./storefront";

/** Which language this request is in. */
export async function currentLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** What the site is called on this request: the storefront's name on one, else SITE_NAME. */
export async function currentSiteName(): Promise<string> {
  return (await currentStorefront())?.name ?? siteName();
}

/** The lookup for this request, for a server component. */
export async function serverT(): Promise<T> {
  return translator(await currentLocale(), await currentSiteName());
}
