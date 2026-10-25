"use client";

import { useCallback, useEffect, useState } from "react";
import { MAX_CAPTION, MAX_PHOTOS, type Photo } from "@/lib/photos-shared";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

/**
 * A venue's photos: a cover and up to five more, all optional. Uploaded one
 * at a time, so one bad file does not lose the rest; the server shrinks and
 * converts each, so whatever the phone took is fine.
 */
export function PhotosEditor({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/admin/venues/${venue.id}/photos`;

  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    if (res.ok) setPhotos((await res.json()).photos);
  }, [base]);
  // Only when opened: an owner looking at a hundred venues does not need a hundred galleries.
  useEffect(() => {
    if (open && photos === null) void load();
  }, [open, photos, load]);

  async function upload(files: FileList) {
    setError(null);
    const list = [...files].slice(0, MAX_PHOTOS - (photos?.length ?? 0));
    for (const [i, file] of list.entries()) {
      setBusy(t("ph.uploading", { i: i + 1, n: list.length }));
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(base, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`${file.name}: ${t.err(data, t("ph.couldNotAdd"))}`);
        break;
      }
      setPhotos(data.photos);
    }
    setBusy(null);
  }

  async function change(photo: Photo, method: "PATCH" | "DELETE", body?: object) {
    setError(null);
    const res = await fetch(`${base}/${photo.id}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("ph.failed")));
    setPhotos(data.photos);
  }

  const count = photos?.length ?? 0;
  return (
    <div className="w-full border-t border-slate-100 pt-2 text-sm">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("ph.close") : photos === null ? t("ph.toggle") : t("ph.count", { count, max: MAX_PHOTOS })}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-slate-500">{t("ph.intro", { more: MAX_PHOTOS - 1 })}</p>
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(photos ?? []).map((p, i) => (
              <figure key={p.id} className="space-y-1">
                <div className="relative aspect-[4/3] overflow-hidden rounded-lg" style={{ backgroundColor: p.color }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.src[0].url} alt={p.caption ?? ""} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  {i === 0 && (
                    <span className="absolute left-1 top-1 rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{t("ph.cover")}</span>
                  )}
                </div>
                <input
                  defaultValue={p.caption ?? ""}
                  maxLength={MAX_CAPTION}
                  placeholder={t("ph.captionPlaceholder")}
                  aria-label={t("ph.caption")}
                  onBlur={(e) => {
                    if (e.target.value !== (p.caption ?? "")) void change(p, "PATCH", { caption: e.target.value });
                  }}
                  className="w-full rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                />
                <div className="flex flex-wrap gap-x-2 text-[11px]">
                  {i > 0 && (
                    <button onClick={() => void change(p, "PATCH", { cover: true })} className="text-teal-700 underline">
                      {t("ph.makeCover")}
                    </button>
                  )}
                  {i > 0 && (
                    <button onClick={() => void change(p, "PATCH", { move: -1 })} aria-label={t("ph.earlier")} className="text-slate-600">
                      ←
                    </button>
                  )}
                  {i < count - 1 && (
                    <button onClick={() => void change(p, "PATCH", { move: 1 })} aria-label={t("ph.later")} className="text-slate-600">
                      →
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm(t("ph.removeConfirm"))) void change(p, "DELETE");
                    }}
                    className="text-red-700 underline"
                  >
                    {t("c.remove")}
                  </button>
                </div>
              </figure>
            ))}
          </div>
          {count < MAX_PHOTOS && (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-teal-500">
              {busy ?? (count === 0 ? t("ph.addCover") : t("ph.addPhotos"))}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={busy !== null}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
