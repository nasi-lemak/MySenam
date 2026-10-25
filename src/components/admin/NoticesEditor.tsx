"use client";

import { useCallback, useEffect, useState } from "react";
import type { Notice } from "@/lib/notices";
import { todayLocal } from "./shared";
import { addDays } from "@/lib/time";
import { useStaffT } from "./StaffLanguage";

/**
 * Put up a notice, for some days: a venue's on its own page and storefront,
 * or — for the platform owner — the one on the marketplace's front page.
 */
export function NoticesEditor({ venueId, intro }: { venueId: number | "site"; intro: string }) {
  const t = useStaffT();
  const [open, setOpen] = useState(venueId === "site");
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ text: "", link: "", startsOn: todayLocal(), endsOn: addDays(todayLocal(), 13) });
  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/notices?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setNotices((await res.json()).notices);
  }, [venueId]);
  useEffect(() => {
    if (open && notices === null) void load();
  }, [open, notices, load]);
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="w-full border-t border-slate-100 pt-2 text-sm">
      {venueId !== "site" && (
        <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
          {open ? t("ntc.close") : notices?.length ? t("ntc.count", { n: notices.length }) : t("ntc.toggle")}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-slate-500">{intro}</p>
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          <ul className="space-y-1">
            {(notices ?? []).map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs">
                <span className="flex-1">
                  📣 {n.text}
                  {n.link && <span className="text-slate-500"> → {n.link}</span>}
                  <span className="text-slate-500">
                    {" "}
                    · {t("ntc.dates", { from: n.startsOn, until: n.endsOn })}
                  </span>
                </span>
                <button
                  onClick={async () => {
                    if (!window.confirm(t("ntc.takeDownConfirm"))) return;
                    const res = await fetch(`/api/admin/notices/${n.id}`, { method: "DELETE" });
                    if (res.ok) setNotices((await res.json()).notices);
                  }}
                  className="text-red-700 underline"
                >
                  {t("ntc.takeDown")}
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const res = await fetch("/api/admin/notices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...f, venueId }),
              });
              const out = await res.json();
              if (!res.ok) return setError(t.err(out));
              setNotices(out.notices);
              setF({ ...f, text: "", link: "" });
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="flex min-w-[16rem] flex-1 flex-col text-xs font-medium text-slate-500">
              {t("ntc.field", { n: 160 - f.text.length })}
              <input required minLength={3} maxLength={160} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} className={input} placeholder={t("ntc.placeholder")} />
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("ntc.link")}
              <input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} className={`w-48 ${input}`} placeholder="/tournaments/12" />
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("c.from")}
              <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} className={input} />
            </label>
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("c.until")}
              <input type="date" value={f.endsOn} min={f.startsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} className={input} />
            </label>
            <button className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">{t("ntc.putUp")}</button>
          </form>
        </div>
      )}
    </div>
  );
}
