"use client";

import { useEffect, useState } from "react";
import type { OverridePolicy } from "@/lib/policy-overrides";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

const LABELS: Record<OverridePolicy, StaffPhrase> = {
  house_rules: "r9.set.house_rules",
  strikes: "r9.set.strikes",
  guest_surge: "r9.set.guest_surge",
  assisted: "r9.set.assisted",
  guest_allowance: "gc8.set.guest_allowance",
};

/**
 * Which of the venue's policies its managers may override for one booking at
 * the counter (lib/policy-overrides.ts; ADR 0026). Every one is off until a
 * manager turns it on; the desk sees them and is refused a change.
 */
export function PolicyOverridesEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState<OverridePolicy[] | null>(null);
  const [all, setAll] = useState<OverridePolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || on) return;
    void fetch(`/api/admin/policy-overrides?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { policies?: OverridePolicy[]; overridable?: OverridePolicy[] }) => {
        if (d.policies) setOn(d.policies);
        if (d.overridable) setAll(d.overridable);
      });
  }, [open, on, venueId]);

  async function save(next: OverridePolicy[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/policy-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, policies: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("vn.couldNotSave")));
      setOn(data.policies);
      setNotice(t("r9.set.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("r9.set.hide") : t("r9.set.show")}
      </button>
      {open && on && (
        <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">{t("r9.set.intro")}</p>
          {all.map((p) => (
            <label key={p} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                disabled={busy}
                checked={on.includes(p)}
                onChange={(e) => void save(e.target.checked ? [...on, p] : on.filter((x) => x !== p))}
                className="mt-0.5 accent-teal-600"
              />
              <span>{t(LABELS[p])}</span>
            </label>
          ))}
          <p className="text-xs text-slate-400">{t("r9.set.desk")}</p>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      )}
    </div>
  );
}
