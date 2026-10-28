"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { HouseRules } from "@/lib/house-rules";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
import { ManagerOnly } from "./StaffMay";

const fields = (t: StaffT): { key: keyof HouseRules; label: string; hint: string; max: number; min: number; blank?: string }[] => [
  { key: "upcoming", label: t("hr.upcoming"), hint: t("hr.upcomingHint"), min: 1, max: 50 },
  { key: "perWeek", label: t("hr.perWeek"), hint: t("hr.perWeekHint"), min: 1, max: 50 },
  { key: "perDay", label: t("hr.perDay"), hint: "", min: 1, max: 20 },
  { key: "aheadDays", label: t("hr.aheadDays"), hint: t("hr.aheadDaysHint"), min: 0, max: 90 },
  { key: "memberAheadDays", label: t("hr.memberAheadDays"), hint: t("hr.memberAheadDaysHint"), min: 1, max: 90 },
  { key: "seriesWeeks", label: t("hr.seriesWeeks"), hint: t("hr.seriesWeeksHint"), min: 2, max: 26, blank: "8" },
];

/**
 * Fair use for online bookings: limits per person, or per household where
 * the venue's list gives people the same unit. Blank is no limit. Asked on
 * every path, the counter and the API too (lib/limits.ts `policyCheck`).
 */
export function HouseRulesEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<keyof HouseRules, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const take = (r: HouseRules) =>
    setValues({
      upcoming: r.upcoming?.toString() ?? "",
      perWeek: r.perWeek?.toString() ?? "",
      perDay: r.perDay?.toString() ?? "",
      aheadDays: r.aheadDays?.toString() ?? "",
      memberAheadDays: r.memberAheadDays?.toString() ?? "",
      seriesWeeks: r.seriesWeeks?.toString() ?? "",
    });

  useEffect(() => {
    if (!open || values) return;
    void fetch(`/api/admin/house-rules?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => readJson(r))
      .then((d: { rules?: HouseRules }) => d.rules && take(d.rules));
  }, [open, values, venueId]);

  async function save() {
    if (!values) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/house-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...values }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("vn.couldNotSave")));
      take(data.rules);
      setNotice(t("hr.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("hr.hide") : t("hr.show")}
      </button>
      {open && values && (
        <ManagerOnly may="houseRules" note={false}>
        <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">{t("hr.intro")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields(t).map((f) => (
              <label key={f.key} className="block text-sm">
                {f.label}
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={values[f.key]}
                  placeholder={f.blank ?? t("hr.noLimit")}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
                />
                {f.hint && <span className="mt-0.5 block text-xs text-slate-400">{f.hint}</span>}
              </label>
            ))}
          </div>
          <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {t("c.save")}
          </button>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
        </ManagerOnly>
      )}
    </div>
  );
}
