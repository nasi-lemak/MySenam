"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { Booking, SPORT_ICONS, Sport } from "@/lib/types";

interface Success {
  booking: Booking;
  court: { name: string; sport: Sport };
  venue: { name: string; area: string };
}

export default function CheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
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
      if (!res.ok) throw new Error(data.error ?? "Check-in failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check-in failed");
    } finally {
      setBusy(false);
    }
  }, [token]);

  // Scanning the code is the intent, so check in on arrival.
  useEffect(() => {
    submit();
  }, [submit]);

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        {busy ? (
          <p className="py-8 text-slate-500">Checking you in…</p>
        ) : result ? (
          <>
            <div className="text-5xl">✅</div>
            <h1 className="mt-3 text-xl font-bold">You&apos;re checked in</h1>
            <p className="mt-1 text-sm text-slate-600">
              Enjoy your session, {result.booking.name.split(" ")[0]}.
            </p>
            <dl className="mt-5 space-y-1.5 text-left text-sm">
              {[
                ["Venue", `${result.venue.name} (${result.venue.area})`],
                [
                  "Facility",
                  `${SPORT_ICONS[result.court.sport]} ${result.court.name}`,
                ],
                [
                  "Time",
                  `${formatHour(result.booking.startHour)} – ${formatHour(result.booking.endHour)}`,
                ],
                ["Code", result.booking.code],
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
            <h1 className="mt-3 text-xl font-bold">Couldn&apos;t check you in</h1>
            <p className="mt-2 text-sm text-red-600">{error}</p>
            <button
              onClick={submit}
              className="mt-5 w-full rounded-lg border border-slate-300 py-2 text-sm font-semibold text-slate-700 hover:border-teal-500 hover:text-teal-700"
            >
              Try again
            </button>
            <p className="mt-3 text-xs text-slate-500">
              Still stuck? The front desk can check you in manually.
            </p>
          </>
        )}
        <Link
          href="/"
          className="mt-5 inline-block text-sm font-medium text-teal-700 underline"
        >
          Back to MySenam
        </Link>
      </div>
    </div>
  );
}
