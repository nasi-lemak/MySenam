"use client";

import { useEffect, useState } from "react";
import type { HouseRules } from "@/lib/house-rules";

const FIELDS: { key: keyof HouseRules; label: string; hint: string; max: number; min: number }[] = [
  { key: "upcoming", label: "Bookings coming up at once", hint: "e.g. 2 — a third waits until one is played or cancelled", min: 1, max: 50 },
  { key: "perWeek", label: "Bookings a week", hint: "Monday to Sunday", min: 1, max: 50 },
  { key: "perDay", label: "Bookings a day", hint: "", min: 1, max: 20 },
  { key: "aheadDays", label: "Days ahead they may book", hint: "0 is today only; blank is 14 days; up to 90", min: 0, max: 90 },
  {
    key: "memberAheadDays",
    label: "Days ahead members may book",
    hint: "Longer than everybody's, so members get first pick; blank is the same",
    min: 1,
    max: 90,
  },
];

/**
 * Fair use for online bookings: limits per person, or per household where
 * the venue's list gives people the same unit. Blank is no limit. Staff at the
 * counter are not held to them.
 */
export function HouseRulesEditor({ venueId }: { venueId: number }) {
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
    });

  useEffect(() => {
    if (!open || values) return;
    void fetch(`/api/admin/house-rules?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      take(data.rules);
      setNotice("Saved. Customers see these on the venue page.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? "Hide house rules" : "House rules: fair use for online bookings"}
      </button>
      {open && values && (
        <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500">
            Limits for each person — or each household, where your list gives people the same unit. Blank is no limit. Only
            court bookings count, and your staff can still book anyone at the counter.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="block text-sm">
                {f.label}
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={values[f.key]}
                  placeholder="no limit"
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
                />
                {f.hint && <span className="mt-0.5 block text-xs text-slate-400">{f.hint}</span>}
              </label>
            ))}
          </div>
          <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            Save
          </button>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      )}
    </div>
  );
}
