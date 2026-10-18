"use client";

import { useEffect, useState } from "react";
import { srcSet, type Photo } from "@/lib/photos-shared";

/**
 * A venue's photos: the cover and the rest in a strip of fixed height, which
 * holds its place and shows each photo's own colour until it arrives, so the
 * page below never jumps and the booking grid never waits for a picture.
 * Tapping one opens it full size.
 */
export function VenueGallery({ photos, venueName, labels }: { photos: Photo[]; venueName: string; labels: { close: string; prev: string; next: string } }) {
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (open === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen((i) => (i === null ? null : (i + 1) % photos.length));
      if (e.key === "ArrowLeft") setOpen((i) => (i === null ? null : (i - 1 + photos.length) % photos.length));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, photos.length]);

  if (photos.length === 0) return null;
  const shown = open === null ? null : photos[open];
  return (
    <>
      <div className="flex h-36 snap-x gap-1.5 overflow-x-auto rounded-xl sm:h-56">
        {photos.map((p, i) => (
          <button
            key={p.id}
            onClick={() => setOpen(i)}
            className={`relative h-full shrink-0 snap-start overflow-hidden rounded-lg ${
              i === 0 ? (photos.length === 1 ? "w-full" : "w-[85%] sm:w-1/2") : "w-[60%] sm:w-1/4"
            }`}
            style={{ backgroundColor: p.color }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.src[Math.min(1, p.src.length - 1)].url}
              srcSet={srcSet(p)}
              sizes={i === 0 ? "(min-width: 640px) 50vw, 85vw" : "(min-width: 640px) 25vw, 60vw"}
              alt={p.caption ?? (i === 0 ? venueName : "")}
              width={p.width}
              height={p.height}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
      {shown && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={shown.caption ?? venueName}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
          onClick={() => setOpen(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shown.src[shown.src.length - 1].url}
            srcSet={srcSet(shown)}
            sizes="100vw"
            alt={shown.caption ?? venueName}
            className="max-h-[85vh] max-w-full rounded object-contain"
            style={{ backgroundColor: shown.color }}
            onClick={(e) => e.stopPropagation()}
          />
          {shown.caption && <p className="mt-3 text-sm text-white">{shown.caption}</p>}
          <div className="mt-3 flex gap-4 text-sm text-white" onClick={(e) => e.stopPropagation()}>
            {photos.length > 1 && (
              <button onClick={() => setOpen((open! - 1 + photos.length) % photos.length)} className="rounded border border-white/40 px-3 py-1">
                ← {labels.prev}
              </button>
            )}
            <button onClick={() => setOpen(null)} className="rounded border border-white/40 px-3 py-1">
              {labels.close}
            </button>
            {photos.length > 1 && (
              <button onClick={() => setOpen((open! + 1) % photos.length)} className="rounded border border-white/40 px-3 py-1">
                {labels.next} →
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
