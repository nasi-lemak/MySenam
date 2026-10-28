"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Addon } from "@/lib/addons";
import type { CounterDay } from "@/lib/counter-sales";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import { money } from "@/lib/region";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

/**
 * Selling over the counter with no booking (lib/counter-sales.ts): tap items
 * from the venue's list of extras, or type one in, take the money, and the
 * receipt is ready to print. Below, the day's sales to count the till against.
 */

type CartLine = { key: string; addonId: number | null; name: string; price: number; quantity: number };

export function CounterSalesPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [date, setDate] = useState(todayLocal());
  const [addons, setAddons] = useState<Addon[]>([]);
  const [day, setDay] = useState<CounterDay | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [via, setVia] = useState<CounterMethod>("cash");
  const [customer, setCustomer] = useState("");
  const [other, setOther] = useState({ name: "", price: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; path: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const [a, d] = await Promise.all([
        fetch(`/api/admin/addons?venueId=${venueId}`, { cache: "no-store" }).then((r) => readJson(r)),
        fetch(`/api/admin/counter-sales?venueId=${venueId}&date=${date}`, { cache: "no-store" }).then((r) => readJson(r)),
      ]);
      setAddons(((a.addons ?? []) as Addon[]).filter((x) => x.active && x.price > 0));
      setDay(d.sales ? d : null);
    } catch {
      setError(t("pos.loadFailed"));
    }
  }, [venueId, date, t]);

  useEffect(() => {
    load();
  }, [load]);

  const add = (line: Omit<CartLine, "quantity" | "key">) =>
    setCart((c) => {
      const key = line.addonId !== null ? `a${line.addonId}` : `o${line.name}|${line.price}`;
      const found = c.find((l) => l.key === key);
      return found ? c.map((l) => (l.key === key ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l)) : [...c, { ...line, key, quantity: 1 }];
    });
  const total = Math.round(cart.reduce((s, l) => s + l.price * l.quantity, 0) * 100) / 100;

  async function sell() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/counter-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          via,
          customerName: customer || undefined,
          items: cart.map((l) => (l.addonId !== null ? { addonId: l.addonId, quantity: l.quantity } : { name: l.name, price: l.price, quantity: l.quantity })),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("pos.saleFailed")));
      setNotice({ text: t("pos.sold", { amount: money(data.sale.total), via: t(`c.via.${via}`), number: data.sale.receipt?.number ?? "" }), path: data.sale.receipt?.path ?? null });
      setCart([]);
      setCustomer("");
      setDate(todayLocal());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pos.saleFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function voidSale(id: number) {
    const reason = window.prompt(t("pos.voidPrompt"));
    if (!reason) return;
    setError(null);
    const res = await fetch(`/api/admin/counter-sales/${id}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const data = await readJson(res);
    if (!res.ok) setError(t.err(data, t("pos.voidFailed")));
    await load();
  }

  const intro = t("pos.intro").split("{section}");
  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <section className="border-t border-slate-200 pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("pos.title")}</h2>
        {venues.length > 1 && (
          <select value={venueId} onChange={(e) => { setVenueId(Number(e.target.value)); setCart([]); }} aria-label={t("c.venue")} className={input}>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-600">
        {intro[0]}
        <em>{t("pos.extrasSection")}</em>
        {intro[1]}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {addons.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => add({ addonId: a.id, name: a.kind === "rental" ? t("pos.hire", { name: a.name }) : a.name, price: a.price })}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:border-teal-500"
          >
            {a.kind === "rental" ? t("pos.hire", { name: a.name }) : a.name} · {money(a.price)}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const price = Number(other.price);
          if (other.name.trim().length < 2 || !(price > 0)) return setError(t("pos.nameAndPrice"));
          setError(null);
          add({ addonId: null, name: other.name.trim(), price: Math.round(price * 100) / 100 });
          setOther({ name: "", price: "" });
        }}
      >
        <input className={input} placeholder={t("pos.otherItem")} value={other.name} maxLength={60} onChange={(e) => setOther({ ...other, name: e.target.value })} aria-label={t("pos.otherItem")} />
        <input className={`${input} w-28`} placeholder={t("pos.priceField")} inputMode="decimal" value={other.price} onChange={(e) => setOther({ ...other, price: e.target.value })} aria-label={t("pos.price")} />
        <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm">{t("c.add")}</button>
      </form>

      {cart.length > 0 && (
        <div className="mt-3 max-w-xl rounded-lg border border-slate-200 bg-white p-3">
          <ul className="divide-y divide-slate-100 text-sm">
            {cart.map((l) => (
              <li key={l.key} className="flex items-center justify-between gap-2 py-1.5">
                <span>{l.name}</span>
                <span className="flex items-center gap-2">
                  <button type="button" aria-label={t("pos.oneFewer", { name: l.name })} className="rounded border px-2" onClick={() => setCart((c) => c.flatMap((x) => (x.key !== l.key ? [x] : x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : [])))}>
                    −
                  </button>
                  <span className="w-6 text-center tabular-nums">{l.quantity}</span>
                  <button type="button" aria-label={t("pos.oneMore", { name: l.name })} className="rounded border px-2" onClick={() => add(l)}>
                    +
                  </button>
                  <span className="w-20 text-right tabular-nums">{money(l.price * l.quantity)}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
            <span className="text-base font-bold">{money(total)}</span>
            <select value={via} onChange={(e) => setVia(e.target.value as CounterMethod)} aria-label={t("pos.paidBy")} className={input}>
              {COUNTER_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`c.via.${m}`)}
                </option>
              ))}
            </select>
            <input className={input} placeholder={t("pos.customerOptional")} value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label={t("pos.customerName")} />
            <button type="button" disabled={busy} onClick={() => void sell()} className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {t("pos.take", { amount: money(total) })}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {notice && (
        <p className="mt-2 text-sm text-emerald-700">
          {notice.text}
          {notice.path && (
            <>
              {" · "}
              <a href={notice.path} target="_blank" rel="noreferrer" className="font-medium underline">
                {t("pos.printReceipt")}
              </a>
            </>
          )}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t("pos.salesOn")}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} aria-label={t("pos.salesOn")} />
        {day && (
          <span className="text-slate-600">
            {money(day.total)}
            {day.byMethod.length > 0 && ` — ${day.byMethod.map((m) => `${t(`c.via.${m.via}`)} ${money(m.total)}`).join(", ")}`}
          </span>
        )}
      </div>
      {day && day.sales.length > 0 && (
        <ul className="mt-2 max-w-xl divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
          {day.sales.map((s) => (
            <li key={s.id} className={`flex flex-wrap items-start justify-between gap-2 p-2 ${s.voidedAt ? "text-slate-400" : ""}`}>
              <div className="min-w-0">
                <p className={s.voidedAt ? "line-through" : ""}>{s.lines.map((l) => (l.quantity > 1 ? `${l.name} × ${l.quantity}` : l.name)).join(", ")}</p>
                <p className="text-xs text-slate-500">
                  {s.receipt?.number} · {t(`c.via.${s.paidVia}`)}
                  {s.customerName && ` · ${s.customerName}`}
                  {s.soldBy && ` · ${t("pos.soldBy", { name: s.soldBy })}`}
                  {s.voidedAt && ` · ${t("pos.voided", { reason: s.voidReason ?? "" })}`}
                </p>
              </div>
              <span className="flex items-center gap-3">
                <span className="tabular-nums">{money(s.total)}</span>
                {s.receipt && (
                  <a href={s.receipt.path} target="_blank" rel="noreferrer" className="text-teal-700 hover:underline">
                    {t("pos.receipt")}
                  </a>
                )}
                {!s.voidedAt && (
                  <button type="button" onClick={() => void voidSale(s.id)} className="text-rose-700 hover:underline">
                    {t("pos.void")}
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
