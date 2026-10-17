"use client";

import { useState } from "react";
import { useT } from "@/components/Language";

export interface NearChoice {
  lat: number;
  lng: number;
  km: number;
  /** "you", or the place typed. */
  where: string | null;
}

const RADII = [5, 10, 25, 50];

/**
 * Somewhere to search around: the phone's own location, or a place typed and
 * looked up. Shown as "Within 10 km of Bangsar", with how far out, and a way
 * back to anywhere.
 */
export function NearPicker({
  value,
  onChange,
}: {
  value: NearChoice | null;
  onChange: (near: NearChoice | null) => void;
}) {
  const t = useT();
  const [place, setPlace] = useState("");
  const [status, setStatus] = useState<null | "locating" | "notFound" | "locationFailed">(null);
  const km = value?.km ?? 10;

  function here() {
    if (!navigator.geolocation) return setStatus("locationFailed");
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStatus(null);
        onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude, km, where: null });
      },
      () => setStatus("locationFailed"),
      { timeout: 10_000, maximumAge: 300_000 }
    );
  }

  async function lookUp(e: React.FormEvent) {
    e.preventDefault();
    const q = place.trim();
    if (q.length < 3) return;
    setStatus("locating");
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as { found?: { lat: number; lng: number } | null };
      if (!res.ok || !data.found) return setStatus("notFound");
      setStatus(null);
      onChange({ lat: data.found.lat, lng: data.found.lng, km, where: q });
    } catch {
      setStatus("notFound");
    }
  }

  const control = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={here}
          className="rounded-full bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          📍 {t("near.me")}
        </button>
        <form onSubmit={lookUp} className="flex min-w-0 flex-1 gap-2">
          <input
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            placeholder={t("near.placeholder")}
            aria-label={t("near.placeholder")}
            className={`min-w-0 flex-1 ${control}`}
          />
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:border-teal-500">
            {t("near.go")}
          </button>
        </form>
      </div>
      {status && <p className="text-xs text-slate-500">{t(`near.${status}`)}</p>}
      {value && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-teal-800">
            {t("near.within", { km: value.km, where: value.where ?? t("near.you") })}
          </span>
          {RADII.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChange({ ...value, km: r })}
              className={`rounded-full border px-2 py-0.5 text-xs ${
                r === value.km ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white hover:border-teal-500"
              }`}
            >
              {r} km
            </button>
          ))}
          <button type="button" onClick={() => onChange(null)} className="text-xs text-slate-500 underline">
            {t("near.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
