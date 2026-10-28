"use client";

import { useState } from "react";
import { money } from "@/lib/region";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import type { PriceAdjustment } from "@/lib/price-adjustments";
import { useStaffT } from "./StaffLanguage";
import { useStaffRole } from "./useStaffRole";

/** What the adjustment needs to know of a booking on the day list. */
interface Row {
  code: string;
  status: string;
  paymentStatus: string;
  paidVia?: string | null;
  totalPrice: number;
  sharesPaid: number;
}

/**
 * A manager's *Adjust price* on one booking (X1-17; lib/price-adjustments.ts):
 * a new amount or complimentary, with the reason, before it is paid; after a
 * counter payment, only lower, the difference on a credit note. Shown to
 * managers only; the server refuses the desk regardless.
 */
export function AdjustPrice({ b, onDone }: { b: Row; onDone: () => void }) {
  const t = useStaffT();
  const who = useStaffRole();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [free, setFree] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [history, setHistory] = useState<PriceAdjustment[]>([]);

  const paid = b.paymentStatus === "paid";
  const atCounter = paid && COUNTER_METHODS.includes(b.paidVia as CounterMethod);
  if (who?.role !== "manager" || b.status !== "confirmed" || (paid && !atCounter)) return null;

  async function show() {
    setOpen(true);
    setError(null);
    setDone(null);
    // What it costs now: paid, the customer's own part (others' shares are theirs).
    setAmount(String(paid ? b.totalPrice - b.sharesPaid : b.totalPrice));
    const res = await fetch(`/api/admin/bookings/adjust-price?code=${encodeURIComponent(b.code)}`, { cache: "no-store" });
    if (res.ok) setHistory((await res.json()).adjustments ?? []);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/bookings/adjust-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: b.code, ...(free ? { complimentary: true } : { amount: Number(amount) }), reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(t.err(data, t("p8b.adj.failed")));
      setDone(
        data.creditNote
          ? t("p8b.adj.doneAfterPaid", { amount: money(-data.adjustment.delta), number: data.creditNote.number, via: t(`c.via.${b.paidVia as CounterMethod}`) })
          : t("p8b.adj.done", { from: money(data.adjustment.before), to: money(data.adjustment.after) })
      );
      setOpen(false);
      setReason("");
      setFree(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p8b.adj.failed"));
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <span className="mt-1 block text-xs">
      {!open && (
        <button type="button" onClick={() => void show()} className="text-slate-500 underline hover:text-teal-700">
          {t("p8b.adj.open")}
        </button>
      )}
      {done && <span className="ml-2 text-emerald-700">{done}</span>}
      {open && (
        <form onSubmit={save} className="mt-1 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <p className="w-full text-slate-600">{paid ? t("p8b.adj.paidNote", { via: t(`c.via.${b.paidVia as CounterMethod}`) }) : t("p8b.adj.unpaidNote")}</p>
          {history.length > 0 && (
            <ul className="w-full text-slate-500">
              {history.map((h) => (
                <li key={h.id}>{t("p8b.adj.was", { from: money(h.before), to: money(h.after), who: h.adminName, reason: h.reason })}</li>
              ))}
            </ul>
          )}
          <label className="flex items-center gap-1 self-center text-slate-600">
            <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} className="accent-teal-600" />
            {t("p8b.adj.free")}
          </label>
          {!free && (
            <label className="flex flex-col font-medium text-slate-500">
              {t("p8b.adj.newPrice")}
              <input type="number" required min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} className={`mt-1 w-24 ${input}`} />
            </label>
          )}
          <label className="flex flex-col font-medium text-slate-500">
            {t("p8b.adj.reason")}
            <input required minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("p8b.adj.reasonExample")} className={`mt-1 w-64 ${input}`} />
          </label>
          <button type="submit" disabled={busy} className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            {t("p8b.adj.save")}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="px-1 text-slate-500 underline">
            {t("c.neverMind")}
          </button>
          {error && <p className="w-full text-rose-700">{error}</p>}
        </form>
      )}
    </span>
  );
}
