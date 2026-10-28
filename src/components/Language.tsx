"use client";

import { createContext, useContext, useMemo } from "react";
import { setBrowserCountry } from "@/lib/region";
import { setActivities, type Activity } from "@/lib/activity-registry";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_NAMES, LOCALE_SHORT, Locale, offeredLocales, translator, T } from "@/lib/i18n";
import { staffLocale, staffLocales } from "@/lib/staff-locales";

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

/**
 * Kept for the browser session once the dashboard has followed the account's
 * own language, or its reader has chosen one with the switch
 * (`useAccountLanguage`, components/admin/StaffLanguage.tsx).
 */
export const STAFF_LANGUAGE_SETTLED = "ms_staff_lang_settled";

/**
 * Switch language. Sets the cookie, then reloads so the server agrees. On the
 * staff dashboard (`staff`), only the languages staff screens are in, and the
 * choice is saved to the signed-in account as well (lib/admin-auth.ts
 * `setAdminLocale`): the dashboard opens in it on their other devices, and
 * what MySenam sends them is written in it. Signed out there is no account,
 * and the cookie alone is set.
 */
export function LanguageToggle({ staff = false }: { staff?: boolean }) {
  const locale = useContext(LanguageContext);
  const current: Locale = staff ? staffLocale(locale) : locale;
  const t = translator(locale);

  async function choose(next: Locale) {
    if (next === current) return;
    if (staff) {
      await fetch("/api/admin/auth/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      }).catch(() => null);
      // Chosen here: not to be overridden by the account's language this session.
      try {
        sessionStorage.setItem(STAFF_LANGUAGE_SETTLED, next);
      } catch {
        // No storage: the choice is still saved, and the cookie still set.
      }
    }
    // A year, site-wide, and Lax so it survives arriving from a venue's link.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // A full reload rather than router.refresh(): the <html lang> and the
    // metadata are server-rendered too, and this is a once-in-a-while click.
    window.location.reload();
  }

  const offered: Locale[] = staff ? staffLocales() : offeredLocales();
  // One language: nothing to switch between.
  if (offered.length < 2) return null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t("lang.label")}>
      {offered.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => void choose(code)}
          aria-current={code === current ? "true" : undefined}
          title={LOCALE_NAMES[code]}
          // Comfortably over the 24×24 minimum a tap target needs.
          className={`inline-flex min-h-7 min-w-10 items-center justify-center rounded-full px-2 text-xs font-semibold uppercase transition ${
            code === current
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
