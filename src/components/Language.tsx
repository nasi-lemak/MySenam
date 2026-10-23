"use client";

import { createContext, useContext, useMemo } from "react";
import { setBrowserCountry } from "@/lib/region";
import { setActivities, type Activity } from "@/lib/activity-registry";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_NAMES, LOCALE_SHORT, Locale, offeredLocales, translator, T } from "@/lib/i18n";

const LanguageContext = createContext<Locale>(DEFAULT_LOCALE);

/**
 * The lookup itself, memoised.
 *
 * `translator()` builds a fresh object each call, and an unstable `t` in a
 * hook's dependency list re-creates every callback that mentions it on every
 * render. One of those callbacks checks a customer in, so this has to be the
 * same object until the language actually changes.
 */
const TContext = createContext<T>(translator(DEFAULT_LOCALE));

/**
 * The language, handed down from the server render.
 *
 * The cookie is read once, by the root layout, so every client component below
 * agrees with the server about which language the page is in. Switching sets
 * the cookie and asks Next to re-render, which flows a new value through here.
 */
export function LanguageProvider({
  locale,
  site,
  country,
  activities,
  children,
}: {
  locale: Locale;
  /** The install's name, which only the server knows. */
  site?: string;
  /** The install's country (lib/region.ts), which only the server knows. */
  country?: string;
  /** The activity catalogue as the server has it (lib/activities.ts), so names, icons and usual rules match it. */
  activities?: Activity[];
  children: React.ReactNode;
}) {
  if (country) setBrowserCountry(country);
  if (activities) setActivities(activities);
  const t = useMemo(() => translator(locale, site), [locale, site]);
  return (
    <LanguageContext.Provider value={locale}>
      <TContext.Provider value={t}>{children}</TContext.Provider>
    </LanguageContext.Provider>
  );
}

/** The lookup for this page, for a client component. */
export function useT(): T {
  return useContext(TContext);
}

/** Switch language. Sets the cookie, then reloads so the server agrees. */
export function LanguageToggle() {
  const locale = useContext(LanguageContext);
  const t = translator(locale);

  function choose(next: Locale) {
    if (next === locale) return;
    // A year, site-wide, and Lax so it survives arriving from a venue's link.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // A full reload rather than router.refresh(): the <html lang> and the
    // metadata are server-rendered too, and this is a once-in-a-while click.
    window.location.reload();
  }

  const offered = offeredLocales();
  // One language: nothing to switch between.
  if (offered.length < 2) return null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t("lang.label")}>
      {offered.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => choose(code)}
          aria-current={code === locale ? "true" : undefined}
          title={LOCALE_NAMES[code]}
          // Comfortably over the 24×24 minimum a tap target needs.
          className={`inline-flex min-h-7 min-w-10 items-center justify-center rounded-full px-2 text-xs font-semibold uppercase transition ${
            code === locale
              ? "bg-slate-900 text-white"
              : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          }`}
        >
          {LOCALE_SHORT[code]}
        </button>
      ))}
    </div>
  );
}
