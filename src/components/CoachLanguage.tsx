"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import { useT } from "@/components/Language";
import { LOCALE_NAMES, offeredLocales, translateError, type Locale } from "@/lib/i18n";
import { staffLocales } from "@/lib/staff-locales";

/**
 * A coach's own language, at their private link (lib/coach-schedule.ts
 * `setCoachLocale`): any language the install offers. This page, its
 * calendar and their lesson emails are written in it; the page reloads in it.
 */
export default function CoachLanguage({ token, chosen }: { token: string; chosen: Locale | null }) {
  const t = useT();
  const [value, setValue] = useState<string>(chosen ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offered = offeredLocales();
  if (offered.length < 2) return null;

  async function choose(next: string) {
    setValue(next);
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/coach/${token}/language`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next || null }),
    }).catch(() => null);
    const data = res ? await readJson(res).catch(() => ({})) : {};
    setBusy(false);
    if (!res?.ok) {
      setValue(chosen ?? "");
      return setError(translateError(t, data) || data.error || t("sl8.coach.langFailed"));
    }
    window.location.reload();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <label className="font-semibold">
        {t("sl8.coach.lang")}{" "}
        <select
          value={value}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          className="ml-1 rounded-md border border-slate-300 px-2 py-1 font-normal"
        >
          <option value="">{t("sl8.coach.langUnset", { lang: LOCALE_NAMES[staffLocales()[0]] })}</option>
          {offered.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-slate-500">{t("sl8.coach.langHelp")}</p>
      {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}
