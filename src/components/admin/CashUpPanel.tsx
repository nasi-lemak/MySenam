"use client";

import { useEffect, useRef, useState } from "react";
import type { CashUp } from "@/lib/cash-up";
import type { ManagedVenue } from "./shared";
import { CashUpSheet } from "./CashUpSheet";
import { useStaffClock, useStaffT } from "./StaffLanguage";

type Loaded = CashUp & { scope: "own" | "all"; deskDays: string[] };

/**
 * The cash-up (X1-2; lib/cash-up.ts): a day's takings and money given back,
 * by method, from every kind of sale, to count the drawer, the QR account and
 * the card terminal against. Front desk sees its own shift (today or
 * yesterday); a manager everybody's or one person's, any day. Printable.
 */
export function CashUpPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [date, setDate] = useState("");
  const [staffId, setStaffId] = useState("");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    if (!venueId) return;
    const mine = ++asked.current;
    setError(null);
    void fetch(`/api/admin/cash-up?venueId=${venueId}${date ? `&date=${date}` : ""}${staffId ? `&staffId=${staffId}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (mine !== asked.current) return;
        if (!r.ok) {
          setData(null);
          setError(t.err(body, t("p8b.cash.failed")));
          return;
        }
        setData(body as Loaded);
        if (!date) setDate((body as Loaded).date);
      })
      .catch(() => mine === asked.current && setError(t("p8b.cash.failed")));
  }, [venueId, date, staffId, t]);

  const own = data?.scope === "own";
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  const printUrl = `/admin/cash-up?venueId=${venueId}${date ? `&date=${date}` : ""}${staffId ? `&staffId=${staffId}` : ""}`;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t("p8b.cash.title")}</h3>
        <a href={printUrl} target="_blank" rel="noreferrer" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-teal-700 hover:border-teal-500">
          {t("p8b.cash.print")}
        </a>
      </div>
      <p className="mt-1 text-xs text-slate-500">{own ? t("p8b.cash.introOwn") : t("p8b.cash.intro")}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {venues.length > 1 && (
          <select
            value={venueId}
            onChange={(e) => {
              setVenueId(Number(e.target.value));
              setStaffId("");
            }}
            aria-label={t("c.venue")}
            className={input}
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        {own ? (
          <select value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("p8b.cash.day")} className={input}>
            {data!.deskDays.map((d, i) => (
              <option key={d} value={d}>
                {i === 0 ? t("p8b.cash.today", { date: d }) : t("p8b.cash.yesterday", { date: d })}
              </option>
            ))}
          </select>
        ) : (
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("p8b.cash.day")} className={input} />
        )}
        {!own && data && (
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label={t("p8b.cash.who")} className={input}>
            <option value="">{t("p8b.cash.everybody")}</option>
            {data.staff.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {data && (
        <div className="mt-3">
          <CashUpSheet data={data} t={t} time={(at) => clock.time(at, venueId)} />
        </div>
      )}
    </section>
  );
}
