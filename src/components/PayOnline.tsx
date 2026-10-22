"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";

/**
 * Pay for one or more bookings on the venue's payment page.
 *
 * Shown only where the venue takes payment online. Nothing is marked paid
 * here: the customer is sent to the gateway, and the booking changes when the
 * gateway says the money arrived.
 */
export default function PayOnline({
  codes,
  phone,
  amount,
  held = false,
  depositPercent = null,
}: {
  codes: string[];
  phone: string;
  amount: number;
  /** Held until paid online: the counter is not an option. */
  held?: boolean;
  /** The venue takes this share now to hold it, the rest at the counter (lib/holds.ts). */
  depositPercent?: number | null;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Worked out as the server does: that share of the whole, to the cent.
  const deposit = depositPercent ? Math.round(amount * depositPercent) / 100 : null;

  async function pay(asDeposit = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes, phone, ...(asDeposit ? { deposit: true } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string")
        throw new Error(translateError(t, data) || t("pay.failed"));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50/60 p-3">
      <button
        type="button"
        onClick={() => void pay()}
        disabled={busy}
        className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {busy ? t("pay.opening") : t("pay.button", { amount })}
      </button>
      {deposit !== null && deposit > 0 && deposit < amount && (
        <>
          <button
            type="button"
            onClick={() => void pay(true)}
            disabled={busy}
            className="mt-2 w-full rounded-lg border border-teal-600 bg-white py-2 font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
          >
            {t("pay.deposit", { pct: depositPercent!, amount: deposit.toFixed(2) })}
          </button>
          <p className="mt-1 text-center text-xs text-slate-600">{t("pay.depositRest", { rest: (Math.round((amount - deposit) * 100) / 100).toFixed(2) })}</p>
        </>
      )}
      <p className="mt-1.5 text-center text-xs text-slate-600">{t(held ? "hold.how" : "pay.how")}</p>
      {error && <p className="mt-1.5 text-center text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}
