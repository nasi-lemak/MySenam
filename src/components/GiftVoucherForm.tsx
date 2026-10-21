"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { money, region } from "@/lib/region";

/** Who is buying a gift voucher, for whom, and how much: then off to pay. */
export default function GiftVoucherForm({ venueId, venueName, min, max }: { venueId: number; venueName: string; min: number; max: number }) {
  const t = useT();
  const [form, setForm] = useState({ amount: "50", buyerName: "", buyerEmail: "", buyerPhone: "", recipientName: "", message: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = Number(form.amount);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form, amount }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string") throw new Error(translateError(t, data) || t("pay.failed"));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(false);
    }
  }

  const input = "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const label = "block text-sm font-medium text-slate-700";
  return (
    <form onSubmit={pay} className="mt-4 space-y-3">
      <label className={label}>
        {t("gift.amount")} ({region().currency.symbol})
        <input type="number" required min={min} max={max} step={0.01} value={form.amount} onChange={set("amount")} className={input} />
      </label>
      <label className={label}>
        {t("gift.yourName")}
        <input required minLength={2} value={form.buyerName} onChange={set("buyerName")} className={input} />
      </label>
      <label className={label}>
        {t("gift.yourEmail")}
        <input type="email" required value={form.buyerEmail} onChange={set("buyerEmail")} className={input} />
      </label>
      <label className={label}>
        {t("gift.yourPhone")}
        <input type="tel" value={form.buyerPhone} onChange={set("buyerPhone")} className={input} />
      </label>
      <label className={label}>
        {t("gift.to")}
        <input value={form.recipientName} onChange={set("recipientName")} maxLength={100} className={input} />
      </label>
      <label className={label}>
        {t("gift.message")}
        <textarea value={form.message} onChange={set("message")} maxLength={300} rows={3} className={input} />
      </label>
      <p className="text-xs text-slate-500">{t("gift.terms", { venue: venueName })}</p>
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
      <button
        disabled={busy || !(amount >= min && amount <= max)}
        className="w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {t("gift.pay", { amount: amount >= min ? money(amount) : "" })}
      </button>
    </form>
  );
}
