"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { money } from "@/lib/region";

/** A dearer coach's difference on a paid lesson, as the customer sees it (lib/lesson-coaches.ts coachDifferences). */
export interface CoachDifferenceItem {
  changeId: number;
  amount: number;
  coach: string;
  state: "owed" | "paying" | "paid";
  via: string | null;
  receiptUrl: string | null;
}

/**
 * What the venue's change of coach left owed, and paying it: online, where
 * the venue takes payment online (exactly that amount, on the venue's own
 * payment page), or at the counter. Nothing is marked paid here: the customer
 * is sent to the gateway, and the difference is paid when the gateway says the
 * money arrived. `source`: the booking's code and phone (the booking page), or
 * the email's link.
 */
export function CoachDifference({
  items,
  source,
  payOnline,
}: {
  items: CoachDifferenceItem[];
  source: { code: string; phone: string } | { token: string };
  payOnline: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pay(changeId: number) {
    setBusy(changeId);
    setError(null);
    try {
      const res = await fetch("/api/payments/coach-difference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("token" in source ? { token: source.token } : { ...source, changeId }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string") throw new Error(translateError(t, data) || t("pay.failed"));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(null);
    }
  }

  if (items.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" data-testid="coach-difference">
      {items.map((d) =>
        d.state === "paid" ? (
          <p key={d.changeId} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {t(d.via === "online" ? "cp7.paidOnline" : "cp7.paidCounter", { amount: money(d.amount), coach: d.coach })}
            {d.receiptUrl && (
              <a href={d.receiptUrl} target="_blank" rel="noopener" className="ml-2 font-semibold underline">
                {t("mine.receipt")}
              </a>
            )}
          </p>
        ) : (
          <div key={d.changeId} className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm">
            <p className="font-medium text-amber-900">{t("cp7.owed", { amount: money(d.amount), coach: d.coach })}</p>
            {payOnline ? (
              <>
                <button
                  type="button"
                  onClick={() => void pay(d.changeId)}
                  disabled={busy !== null}
                  className="mt-2 w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {busy === d.changeId ? t("pay.opening") : t(d.state === "paying" ? "cp7.payContinue" : "cp7.pay", { amount: money(d.amount) })}
                </button>
                <p className="mt-1.5 text-center text-xs text-slate-600">{t("cp7.orCounter")}</p>
              </>
            ) : (
              <p className="mt-1 text-xs text-slate-600">{t("cp7.atCounter")}</p>
            )}
          </div>
        )
      )}
      {error && <p className="text-center text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}
