"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { Booking, ClassSession } from "@/lib/types";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import WaiverTick from "@/components/WaiverTick";

export default function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [result, setResult] = useState<{ booking: Booking; session: ClassSession | null } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The venue's waiver, asked here where the place is booked: its venue, once the claim says one is needed.
  const [waiverVenue, setWaiverVenue] = useState<{ id: number; name: string } | null>(null);
  const [agreeWaiver, setAgreeWaiver] = useState(false);

  const claim = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(agreeWaiver ? { agreeWaiver: true } : {}) }),
      });
      const data = await res.json();
      // Not agreed to yet: the offer still stands; tick the box and claim again.
      if (!res.ok && data?.code === "WAIVER_NEEDED" && Number.isInteger(data?.vars?.venueId)) {
        setWaiverVenue({ id: data.vars.venueId, name: typeof data.vars.venue === "string" ? data.vars.venue : "" });
        return;
      }
      if (!res.ok) throw new Error(translateError(t, data) || t("claim.failed"));
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("claim.failed"));
    } finally {
      setBusy(false);
    }
  }, [token, t, agreeWaiver]);

  // Unlike check-in, claiming costs money, so it waits for a deliberate tap.
  useEffect(() => {
    setError(null);
  }, [token]);

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        {result ? (
          <>
            <div className="text-5xl">🎉</div>
            <h1 className="mt-3 text-xl font-bold">{t("claim.yoursTitle")}</h1>
            {result.session && (
              <p className="mt-1 text-sm text-slate-600">
                {t("claim.with", {
                  name: result.session.name,
                  instructor: result.session.instructor,
                })}
                <br />
                {result.session.date} · {formatHour(result.session.startHour, t.locale)} –{" "}
                {formatHour(result.session.endHour, t.locale)}
              </p>
            )}
            <div className="mt-4 rounded-xl bg-teal-50 py-3 text-2xl font-bold tracking-widest text-teal-700">
              {result.booking.code}
            </div>
            {/* Booked for whom the place was waited for: a child, never the adult in their place (ADR 0023). */}
            {result.booking.participantName && (
              <p className="mt-2 text-sm font-medium text-slate-700">{t("guard.forLine", { name: result.booking.participantName })}</p>
            )}
            <p className="mt-2 text-xs text-slate-500">
              {t("claim.payable", { amount: result.booking.totalPrice })}
            </p>
          </>
        ) : error ? (
          <>
            <div className="text-5xl">⌛</div>
            <h1 className="mt-3 text-xl font-bold">{t("claim.goneTitle")}</h1>
            <p className="mt-2 text-sm text-red-600">{error}</p>
            <p className="mt-3 text-xs text-slate-500">
              {t("claim.goneBody")}
            </p>
          </>
        ) : (
          <>
            <div className="text-5xl">🎟️</div>
            <h1 className="mt-3 text-xl font-bold">{t("claim.openTitle")}</h1>
            <p className="mt-2 text-sm text-slate-600">
              {t("claim.openBody")}
            </p>
            {waiverVenue !== null && (
              <div className="mt-3 text-left">
                <p className="text-xs text-amber-700">{t("err.WAIVER_NEEDED")}</p>
                <WaiverTick venueId={waiverVenue.id} venueName={waiverVenue.name} checked={agreeWaiver} onChange={setAgreeWaiver} />
              </div>
            )}
            <button
              onClick={claim}
              disabled={busy || (waiverVenue !== null && !agreeWaiver)}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {busy ? t("claim.working") : t("claim.button")}
            </button>
          </>
        )}
        <Link href="/classes" className="mt-5 inline-block text-sm font-medium text-teal-700 underline">
          {t("claim.back")}
        </Link>
      </div>
    </div>
  );
}
