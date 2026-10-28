"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import type { Court } from "@/lib/types";
import { useStaffT } from "./StaffLanguage";

/**
 * Kinds of the same thing under one heading (lib/resources.ts
 * `setCourtHeading`): "Kayaks" over "Single kayak" and "Double kayak", as
 * customers then see them on the venue's page and the booking form. Each is
 * still booked, priced and counted as itself. Saved when the field is left.
 */
export function ResourceHeadings({ courts, onSaved }: { courts: Court[]; onSaved: () => void }) {
  const t = useStaffT();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headings = [...new Set(courts.map((c) => c.heading).filter((h): h is string => !!h))].sort();

  async function save(court: Court, value: string) {
    if (value.trim() === (court.heading ?? "")) return;
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/courts/${court.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heading: value.trim() === "" ? null : value }),
    });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("c.failed")));
    setNotice(t("res.headingSaved", { name: data.court.name }));
    onSaved();
  }

  if (courts.length < 2) return null;
  return (
    <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("res.headingsTitle")}</h3>
      <p className="mt-1 text-sm text-slate-500">{t("res.headingsIntro")}</p>
      <datalist id="resource-headings">
        {headings.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      <table className="mt-2 w-full min-w-[360px] text-sm">
        <tbody>
          {courts.map((court) => (
            <tr key={court.id} className="border-t border-slate-100">
              <td className="py-1.5 pr-3 font-medium">{court.name}</td>
              <td className="py-1.5 pl-3">
                <input
                  key={`${court.id}:${court.heading ?? ""}`}
                  aria-label={t("res.headingAria", { name: court.name })}
                  list="resource-headings"
                  maxLength={40}
                  defaultValue={court.heading ?? ""}
                  placeholder={t("res.headingPlaceholder")}
                  onBlur={(e) => void save(court, e.target.value)}
                  className="w-48 rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
    </section>
  );
}
