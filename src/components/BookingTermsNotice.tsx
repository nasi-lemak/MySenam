"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import type { BookingTerms, YourStanding } from "@/lib/booking-terms";

const KEY = (venueId: number) => `ms-terms-${venueId}`;

/** This browser's "don't show again", for a guest. Storage may be off: then it just shows. */
function readLocal(venueId: number): string | null {
  try {
    return window.localStorage.getItem(KEY(venueId));
  } catch {
    return null;
  }
}

function writeLocal(venueId: number, version: string) {
  try {
    window.localStorage.setItem(KEY(venueId), version);
  } catch {
    // Not remembered; it shows next time.
  }
}

/**
 * "Before you book": the venue's cancellation, no-show and payment rules,
 * next to the button that commits to them (lib/booking-terms.ts). Can be put
 * away for this venue until its rules change; the customer's own strikes are
 * shown regardless.
 */
export default function BookingTermsNotice({ venueId, sport }: { venueId: number; sport?: string }) {
  const t = useT();
  const [terms, setTerms] = useState<BookingTerms | null>(null);
  const [you, setYou] = useState<YourStanding | null>(null);
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    void fetch(`/api/venues/${venueId}/terms${sport ? `?sport=${sport}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { terms: BookingTerms; dismissed: boolean | null; you: YourStanding | null } | null) => {
        if (!d) return;
        setTerms(d.terms);
        setYou(d.you);
        setSignedIn(d.dismissed !== null);
        const dismissed = d.dismissed ?? readLocal(venueId) === d.terms.version;
        setOpen(!dismissed);
      })
      .catch(() => undefined);
  }, [venueId, sport]);

  if (!terms) return null;

  async function dismiss() {
    if (!terms) return;
    setOpen(false);
    writeLocal(venueId, terms.version);
    if (signedIn)
      await fetch(`/api/venues/${venueId}/terms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: terms.version }),
      }).catch(() => undefined);
  }

  const lines = [
    terms.cutoffHours > 0 ? t.plural("mine.freeCancel", terms.cutoffHours) : t("terms.untilStart"),
    ...(terms.cutoffHours > 0 ? [terms.lateKeep !== null ? t("terms.lateKeep", { pct: terms.lateKeep }) : t("terms.lateCall")] : []),
    t("terms.noShow"),
    ...(terms.strikeLimit !== null
      ? [t(terms.struckOutPays ? "terms.strikes" : "terms.strikesCounter", { n: terms.strikeLimit, days: terms.strikeDays })]
      : []),
    ...(terms.holdMinutes !== null ? [t("terms.hold", { m: terms.holdMinutes })] : []),
    ...(terms.holdMinutes !== null && terms.depositPercent ? [t("terms.deposit", { pct: terms.depositPercent })] : []),
    ...(terms.refundsAsCredit ? [t("terms.creditRefund")] : []),
  ];

  return (
    <div className="space-y-2 text-xs">
      {you && (
        <p
          role="alert"
          className={`rounded-lg px-3 py-2 font-medium ${you.out ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}
        >
          ⚠{" "}
          {you.out
            ? t(terms.struckOutPays ? "terms.struck" : "terms.struckCounter", { limit: you.limit })
            : t("terms.yours", { n: you.strikes, limit: you.limit })}
        </p>
      )}
      {open ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-amber-950">
          <p className="font-semibold">📋 {t("terms.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <button type="button" onClick={dismiss} className="mt-1.5 font-medium text-amber-900 underline">
            {t("terms.dismiss")}
          </button>
          <span className="text-amber-800"> · {t("terms.dismissNote")}</span>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="font-medium text-slate-500 underline">
          📋 {t("terms.reopen")}
        </button>
      )}
    </div>
  );
}
