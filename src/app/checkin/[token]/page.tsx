"use client";

import { activityIcon } from "@/lib/activity-registry";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { Booking, Sport } from "@/lib/types";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

interface Success {
  booking: Booking;
  court: { name: string; sport: Sport };
  venue: { name: string; area: string };
}

export default function CheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [result, setResult] = useState<Success | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("checkin.failed"));
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkin.failed"));
    } finally {
      setBusy(false);
    }
  }, [token, t]);

  // Scanning the code is the intent, so check in on arrival.
  useEffect(() => {
    submit();
  }, [submit]);

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        {busy ? (
          <p className="py-8 text-slate-500">{t("checkin.working")}</p>
        ) : result ? (
          <>
            <div className="text-5xl">✅</div>
            <h1 className="mt-3 text-xl font-bold">{t("checkin.doneTitle")}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {t("checkin.doneBody", { name: result.booking.name.split(" ")[0] })}
            </p>
            <dl className="mt-5 space-y-1.5 text-left text-sm">
              {[
                [t("checkin.venue"), `${result.venue.name} (${result.venue.area})`],
                [
                  t("checkin.facility"),
                  `${activityIcon(result.court.sport)} ${result.court.name}`,
                ],
                [
                  t("checkin.time"),
                  `${formatHour(result.booking.startHour, t.locale)} – ${formatHour(result.booking.endHour, t.locale)}`,
                ],
                [t("checkin.code"), result.booking.code],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-right font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <>
            <div className="text-5xl">⚠️</div>
            <h1 className="mt-3 text-xl font-bold">{t("checkin.failedTitle")}</h1>
            <p className="mt-2 text-sm text-red-600">{error}</p>
            <button
              onClick={submit}
              className="mt-5 w-full rounded-lg border border-slate-300 py-2 text-sm font-semibold text-slate-700 hover:border-teal-500 hover:text-teal-700"
            >
              {t("checkin.tryAgain")}
            </button>
            <p className="mt-3 text-xs text-slate-500">
              {t("checkin.stuck")}
            </p>
          </>
        )}
        <Link
          href="/"
          className="mt-5 inline-block text-sm font-medium text-teal-700 underline"
        >
          {t("checkin.back")}
        </Link>
      </div>
    </div>
  );
}
