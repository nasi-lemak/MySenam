"use client";

import { useCallback, useEffect, useState } from "react";
import type { Voucher } from "@/lib/vouchers";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";
import { FIRST_PAGE, ListFilter, listParams, type ListQuery } from "./ListFilter";

type Listed = Voucher & { printUrl: string };

/**
 * Gift vouchers: sell one at the counter, print it, see who has used theirs,
 * and cancel one nobody has. Customers can also buy them online from the
 * venue's page, where it takes payment online.
 */
export function VouchersPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const STATUS: Record<Voucher["status"], string> = {
    pending: t("vch.status.pending"),
    active: t("vch.status.active"),
    redeemed: t("vch.status.redeemed"),
    void: t("vch.status.void"),
  };
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [vouchers, setVouchers] = useState<Listed[]>([]);
  const [form, setForm] = useState({ amount: "50", buyerName: "", buyerEmail: "", recipientName: "", message: "", via: "cash" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; printUrl?: string } | null>(null);
  // Found by code, name, email or number, by status, a page at a time (X1-7).
  const [query, setQuery] = useState<ListQuery>(FIRST_PAGE);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/vouchers?venueId=${venueId}${listParams(query)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setVouchers(data.vouchers);
    setMore(data.more === true);
  }, [venueId, query]);

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
      if (!res.ok) throw new Error(t.err(data, t("vch.sellFailed")));
      setNotice({ text: t("vch.sold", { code: data.voucher.code, amount: money(data.voucher.amount) }), printUrl: data.voucher.printUrl });
      setForm({ ...form, buyerName: "", buyerEmail: "", recipientName: "", message: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vch.sellFailed"));
    }
  }

  /** How it was paid, in the staff language; what was stored when it is not a method this screen knows. */
  const paidHowText = (v: Listed) => {
    const how = v.paidHow;
    if (!how) return v.paidVia ?? "";
    if (how.via === "counter") return t("srv.via.counter");
    if (how.via === "online" && how.gateway) return t("srv.via.onlineGateway", { gateway: how.gateway });
    return t(`c.via.${how.via}`);
  };

  async function cancel(v: Listed) {
    if (!confirm(t(v.paidHow?.via === "online" ? "vch.cancelConfirmOnline" : "vch.cancelConfirmCounter", { code: v.code }))) return;
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/vouchers/${v.id}/void`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) setError(t.err(data, t("vch.cancelFailed")));
    else setNotice({ text: t("vch.cancelled", { code: v.code }) });
    await load();
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section className="border-t border-slate-200 pt-6">
      <h2 className="text-lg font-bold">{t("vch.title")}</h2>
      <p className="mt-1 text-sm text-slate-600">
        {t("vch.intro")}
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
        <input aria-label={t("c.amount")} type="number" min={10} step={0.01} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={input} />
        <input aria-label={t("vch.boughtBy")} placeholder={t("vch.boughtBy")} required value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} className={input} />
        <input aria-label={t("vch.buyerEmail")} placeholder={t("vch.buyerEmail")} type="email" value={form.buyerEmail} onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })} className={input} />
        <input aria-label={t("vch.recipient")} placeholder={t("vch.recipient")} value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} className={input} />
        <input aria-label={t("vch.message")} placeholder={t("vch.message")} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className={input} />
        <select aria-label={t("vch.paidBy")} value={form.via} onChange={(e) => setForm({ ...form, via: e.target.value })} className={input}>
          {COUNTER_METHODS.map((m: CounterMethod) => (
            <option key={m} value={m}>
              {t(`c.via.${m}`)}
            </option>
          ))}
        </select>
        <button className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 sm:col-span-3 sm:justify-self-start">
          {t("vch.sell")}
        </button>
      </form>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && (
        <p className="mt-2 text-sm text-emerald-700">
          {notice.text}{" "}
          {notice.printUrl && (
            <a href={notice.printUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
              {t("vch.printIt")}
            </a>
          )}
        </p>
      )}
      <ListFilter
        query={query}
        onChange={setQuery}
        more={more}
        statuses={[
          { value: "active", label: "p8b.list.active" },
          { value: "lapsing", label: "p8b.list.lapsing" },
          { value: "redeemed", label: "p8b.list.redeemed" },
          { value: "expired", label: "p8b.list.expired" },
          { value: "cancelled", label: "p8b.list.cancelled" },
        ]}
      />
      {vouchers.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm">
          {vouchers.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-mono font-semibold">{v.code}</span> · {money(v.amount)} · {v.buyerName}
                {v.recipientName && ` → ${v.recipientName}`}
                <span className="block text-xs text-slate-500">
                  {STATUS[v.status]}
                  {v.status === "redeemed" && v.redeemedByName && ` ${t("vch.redeemedBy", { name: v.redeemedByName })}`}
                  {v.status === "active" && ` · ${t("vch.until", { date: v.expiresOn })}`} · {paidHowText(v)}
                </span>
              </span>
              <span className="flex gap-3 text-xs font-medium">
                <a href={v.printUrl} target="_blank" rel="noopener noreferrer" className="text-teal-700 underline">
                  {t("c.print")}
                </a>
                {v.status === "active" && (
                  <button onClick={() => cancel(v)} className="text-red-700">
                    {t("c.cancel")}
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
