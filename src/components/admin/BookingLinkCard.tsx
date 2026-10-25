"use client";

import { useEffect, useState } from "react";
import { useStaffT } from "./StaffLanguage";

/**
 * The venue's booking link where staff can reach it: copy it into the
 * WhatsApp group or Instagram bio, or print the QR poster for the counter.
 * Every regular who books by link is one fewer message to answer.
 */
export function BookingLinkCard({ venueId, venueName }: { venueId: number; venueName: string | null }) {
  const t = useStaffT();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetch(`/api/admin/booking-link?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => setUrl(d?.url ?? null))
      .catch(() => setUrl(null));
  }, [venueId]);

  if (!url) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t("link.copyPrompt"), url!);
    }
  }

  const share = `https://wa.me/?text=${encodeURIComponent(venueName ? t("link.shareNamed", { venue: venueName, url }) : t("link.shareOurs", { url }))}`;
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/venues/${venueId}/qr`} alt={t("link.qrAlt")} className="h-20 w-20 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{venueName ? t("link.titleNamed", { venue: venueName }) : t("link.title")}</p>
        <p className="truncate font-mono text-xs text-slate-600">{url}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
          <button onClick={copy} className="rounded-md bg-teal-600 px-2.5 py-1 text-white hover:bg-teal-700">
            {copied ? t("link.copied") : t("link.copy")}
          </button>
          <a href={share} target="_blank" rel="noopener noreferrer" className="rounded-md border border-slate-300 px-2.5 py-1 text-slate-700 hover:border-teal-500">
            {t("link.whatsapp")}
          </a>
          <a href={`/venue/${venueId}/poster`} target="_blank" rel="noopener" className="rounded-md border border-slate-300 px-2.5 py-1 text-slate-700 hover:border-teal-500">
            {t("link.poster")}
          </a>
        </div>
      </div>
    </section>
  );
}
