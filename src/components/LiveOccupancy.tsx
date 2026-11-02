"use client";

import { readJson } from "@/lib/read-response";
import { ActivityGlyph } from "@/components/Glyph";
import { useCallback, useEffect, useState } from "react";
import { Busyness, LiveOccupancy as Live } from "@/lib/types";
import { useT } from "@/components/Language";
import type { Phrase } from "@/lib/i18n";
import { intlTag, region } from "@/lib/region";

const REFRESH_MS = 30_000;

const BAR_STYLES: Record<Busyness, string> = {
  quiet: "bg-emerald-500",
  filling: "bg-amber-500",
  busy: "bg-orange-500",
  full: "bg-red-500",
};

const TEXT_STYLES: Record<Busyness, string> = {
  quiet: "text-emerald-700",
  filling: "text-amber-700",
  busy: "text-orange-700",
  full: "text-red-700",
};

/** Live "how busy is it right now", from door check-ins. */
export default function LiveOccupancy({ venueId }: { venueId: number }) {
  const t = useT();
  const [occupancy, setOccupancy] = useState<Live[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/venues/${venueId}/live`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await readJson(res);
      setOccupancy(data.occupancy);
      setAsOf(data.asOf);
    } catch {
      // A transient failure just leaves the last reading on screen.
    }
  }, [venueId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Only shared facilities have a meaningful headcount.
  const shared = (occupancy ?? []).filter((o) => o.capacity > 1);
  if (shared.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t("live.title")}</h2>
        {asOf && (
          <span className="text-xs text-slate-400">
            {t("live.updated", {
              time: new Date(asOf).toLocaleTimeString(intlTag(t.locale), {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: region().timeZone,
              }),
            })}
          </span>
        )}
      </div>
      <ul className="mt-3 space-y-3">
        {shared.map((o) => (
          <li key={o.courtId}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">
                <ActivityGlyph sport={o.sport} /> {o.courtName}
              </span>
              <span className={`font-semibold ${TEXT_STYLES[o.level]}`}>
                {t(`busy.${o.level}` as Phrase)}
                <span className="ml-2 font-normal text-slate-500">
                  {t("live.inside", { present: o.present, capacity: o.capacity })}
                </span>
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all ${BAR_STYLES[o.level]}`}
                style={{ width: `${Math.min(100, Math.round((o.present / o.capacity) * 100))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-400">{t("live.source")}</p>
    </section>
  );
}
