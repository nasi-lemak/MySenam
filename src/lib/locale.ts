import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, Locale, translator, T } from "./i18n";

/** Which language this request is in. */
export async function currentLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** The lookup for this request, for a server component. */
export async function serverT(): Promise<T> {
  return translator(await currentLocale());
}
