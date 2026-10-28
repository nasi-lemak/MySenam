"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Photo } from "@/lib/photos-shared";
import { useStaffT } from "./StaffLanguage";

/**
 * Photos venues have added in the last fortnight, for the platform owner.
 * A venue's photos are checked when it goes live; these are the ones added
 * since, which nobody has looked at — another venue's courts, a stock
 * picture, a customer's face. Removing one tells nobody; say why yourself.
 */
export function RecentPhotosPanel() {
  const t = useStaffT();
  const [photos, setPhotos] = useState<(Photo & { venueName: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/photos", { cache: "no-store" });
    if (res.ok) setPhotos((await readJson(res)).photos);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(p: Photo) {
    if (!window.confirm(t("rph.removeConfirm"))) return;
    setError(null);
    const res = await fetch(`/api/admin/venues/${p.venueId}/photos/${p.id}`, { method: "DELETE" });
    if (!res.ok) return setError(t.err(await readJson(res).catch(() => null), t("rph.removeFailed")));
    await load();
  }

  return (
    <section>
      <h2 className="text-lg font-bold">{t("rph.title")}</h2>
      <p className="mt-1 text-sm text-slate-500">{t("rph.intro")}</p>
      {error && <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {photos && photos.length === 0 && <p className="mt-2 text-sm text-slate-500">{t("rph.none")}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {(photos ?? []).map((p) => (
          <figure key={p.id} className="space-y-1 text-xs">
            <div className="aspect-[4/3] overflow-hidden rounded-lg" style={{ backgroundColor: p.color }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.src[0].url} alt={p.caption ?? ""} loading="lazy" decoding="async" className="h-full w-full object-cover" />
            </div>
            <figcaption className="truncate text-slate-600">{p.venueName}</figcaption>
            <button onClick={() => void remove(p)} className="text-red-700 underline">
              {t("c.remove")}
            </button>
          </figure>
        ))}
      </div>
    </section>
  );
}
