"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { readJson } from "@/lib/read-response";
import { translateError } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";
import { clockTime, shortDate } from "@/lib/region";
import { localDateOf } from "@/lib/time";
import type { Booking } from "@/lib/types";
import type { MovedLessonOffer } from "@/lib/lesson-venue-moves";
import type { CancelRefund } from "@/lib/payments";

/**
 * A lesson the venue moved, and the customer's own way out (lib/lesson-venue-moves.ts): where it was and is, that the price they agreed
 * stays, and, while the window lasts, one button to cancel it with everything back. Nothing is cancelled or refunded for them: they press it.
 */
export function MovedLesson({
  offer,
  zone,
  cancel,
  onCancelled,
}: {
  offer: MovedLessonOffer;
  zone: string;
  /** How it is asked: by the booking's code and phone, or from an account. */
  cancel: () => Promise<Response>;
  onCancelled: (booking: Booking, refunds: CancelRefund[]) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const span = (x: { date: string; startMin: number; endMin: number }) => `${shortDate(x.date, t.locale, true)}, ${formatMinute(x.startMin, t.locale)}–${formatMinute(x.endMin, t.locale)}`;
  const until = `${shortDate(localDateOf(offer.until, zone), t.locale)}, ${clockTime(new Date(offer.until), zone, t.locale)}`;

  async function go() {
    if (!window.confirm(t("clsb.moved.confirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await cancel();
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("clsb.moved.failed"));
      onCancelled(data.booking as Booking, (data.refunds ?? []) as CancelRefund[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("clsb.moved.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm" data-testid="moved-lesson">
      <p className="font-semibold text-amber-900">{t("clsb.moved.title")}</p>
      <p className="mt-1 text-amber-900">{t("clsb.moved.from", { from: span(offer.from), to: span(offer.to) })}</p>
      <p className="mt-1 text-amber-900">{t("clsb.moved.price")}</p>
      <p className="mt-1 text-amber-900">{t("clsb.moved.refund", { until })}</p>
      <button type="button" disabled={busy} onClick={() => void go()} className="mt-2 w-full rounded-lg border border-amber-600 bg-white py-2.5 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50">
        {t("clsb.moved.cancel")}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
