"use client";

import { useCallback, useEffect, useState } from "react";
import type { Voucher } from "@/lib/vouchers";
import { COUNTER_METHODS, PAID_VIA_LABELS, type CounterMethod } from "@/lib/types";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";

type Listed = Voucher & { printUrl: string };

const STATUS: Record<Voucher["status"], string> = {
  pending: "Being paid for",
  active: "Not used yet",
  redeemed: "Used",
  void: "Cancelled",
};

/**
 * Gift vouchers: sell one at the counter, print it, see who has used theirs,
 * and cancel one nobody has. Customers can also buy them online from the
 * venue's page, where it takes payment online.
 */
export function VouchersPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [vouchers, setVouchers] = useState<Listed[]>([]);
  const [form, setForm] = useState({ amount: "50", buyerName: "", buyerEmail: "", recipientName: "", message: "", via: "cash" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; printUrl?: string } | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/vouchers?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setVouchers((await res.json()).vouchers);
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function sell(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form, amount: Number(form.amount) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not sell the voucher");
      setNotice({ text: `Sold ${data.voucher.code} for ${money(data.voucher.amount)}.`, printUrl: data.voucher.printUrl });
      setForm({ ...form, buyerName: "", buyerEmail: "", recipientName: "", message: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sell the voucher");
    }
  }

  async function cancel(v: Listed) {
    if (!confirm(`Cancel ${v.code}? ${v.paidVia?.startsWith("Online") ? "What was paid is listed under refunds owed." : "Give the money back at the counter."}`))
      return;
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/vouchers/${v.id}/void`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not cancel the voucher");
    else setNotice({ text: `Cancelled ${v.code}.` });
    await load();
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">Gift vouchers</h2>
      <p className="mt-1 text-sm text-slate-600">
        An amount somebody buys for somebody else. Whoever holds it enters the code on their account page and it becomes
        credit here. Good for a year. Customers can also buy them on your venue page when you take payment online.
      </p>
      {venues.length > 1 && (
        <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} className={`mt-3 ${input}`}>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      <form onSubmit={sell} className="mt-3 grid gap-2 sm:grid-cols-3">
        <input aria-label="Amount" type="number" min={10} step={0.01} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={input} />
        <input aria-label="Bought by" placeholder="Bought by" required value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} className={input} />
        <input aria-label="Their email (optional)" placeholder="Their email (optional)" type="email" value={form.buyerEmail} onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })} className={input} />
        <input aria-label="For (optional)" placeholder="For (optional)" value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} className={input} />
        <input aria-label="Message (optional)" placeholder="Message (optional)" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className={input} />
        <select aria-label="Paid by" value={form.via} onChange={(e) => setForm({ ...form, via: e.target.value })} className={input}>
          {COUNTER_METHODS.map((m: CounterMethod) => (
            <option key={m} value={m}>
              {PAID_VIA_LABELS[m]}
            </option>
          ))}
        </select>
        <button className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 sm:col-span-3 sm:justify-self-start">
          Sell voucher
        </button>
      </form>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && (
        <p className="mt-2 text-sm text-emerald-700">
          {notice.text}{" "}
          {notice.printUrl && (
            <a href={notice.printUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
              Print it
            </a>
          )}
        </p>
      )}
      {vouchers.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm">
          {vouchers.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-mono font-semibold">{v.code}</span> · {money(v.amount)} · {v.buyerName}
                {v.recipientName && ` → ${v.recipientName}`}
                <span className="block text-xs text-slate-500">
                  {STATUS[v.status]}
                  {v.status === "redeemed" && v.redeemedByName && ` by ${v.redeemedByName}`}
                  {v.status === "active" && ` · until ${v.expiresOn}`} · {v.paidVia ?? ""}
                </span>
              </span>
              <span className="flex gap-3 text-xs font-medium">
                <a href={v.printUrl} target="_blank" rel="noopener noreferrer" className="text-teal-700 underline">
                  Print
                </a>
                {v.status === "active" && (
                  <button onClick={() => cancel(v)} className="text-red-700">
                    Cancel
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
