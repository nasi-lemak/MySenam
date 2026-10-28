"use client";

import { LOCALE_NAMES, type Locale } from "@/lib/i18n";
import { staffLocales } from "@/lib/staff-locales";
import { useStaffT } from "./StaffLanguage";

/**
 * Somebody's own language, for what MySenam writes to them: a member of
 * staff's (the staff languages), a venue's booking alerts (the same), a
 * coach's (the install's customer languages). Blank is none chosen, when
 * messages go in the install's first staff language, which it names.
 */
export function LanguageChoice({
  value,
  onChange,
  locales,
  label,
  className = "",
  disabled = false,
}: {
  value: string | null | undefined;
  onChange: (locale: string) => void;
  locales: readonly Locale[];
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const t = useStaffT();
  return (
    <select aria-label={label} title={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{t("sl8.lang.unset", { lang: LOCALE_NAMES[staffLocales()[0]] })}</option>
      {locales.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
