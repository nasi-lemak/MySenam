"use client";

import { useCallback, useEffect, useState } from "react";
import { WalletBalance, WalletEntry } from "@/lib/types";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { money } from "@/lib/region";

/** The customer's stored credit and recent movements. */
export default function Wallet() {
  const t = useT();
  const [balance, setBalance] = useState<number | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [perVenue, setPerVenue] = useState(false);
  const [open, setOpen] = useState(false);
  // Where credit can be bought online, and the form for it.
  const [topUpVenues, setTopUpVenues] = useState<{ id: number; name: string }[]>([]);
  const [topUp, setTopUp] = useState<{ venueId: number; amount: string } | null>(null);
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  // A gift voucher being turned into credit.
  const [voucher, setVoucher] = useState("");
  const [voucherNote, setVoucherNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setVoucherNote(null);
    try {
      const res = await fetch("/api/my/vouchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: voucher }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("pay.failed"));
      setVoucher("");
      setVoucherNote({ ok: true, text: t("wallet.redeemDone", { amount: money(data.amount), venue: data.venueName }) });
      await load();
    } catch (err) {
      setVoucherNote({ ok: false, text: err instanceof Error ? err.message : t("pay.failed") });
    }
  }

  async function payTopUp() {
    if (!topUp) return;
    setPaying(true);
    setTopUpError(null);
    try {
      const res = await fetch("/api/my/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: topUp.venueId, amount: Number(topUp.amount) }),
      });
      const data = await res.json();
      if (!res.ok || typeof data.url !== "string") throw new Error(translateError(t, data) || t("pay.failed"));
      window.location.assign(data.url);
    } catch (err) {
      setTopUpError(err instanceof Error ? err.message : t("pay.failed"));
      setPaying(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/my/wallet", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setBalance(data.balance);
      setEntries(data.entries);
      setBalances(data.balances ?? []);
      setPerVenue(data.scope === "venue");
      setTopUpVenues(data.topUpVenues ?? []);
    } catch {
      // Leave the last reading on screen.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (balance === null) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t("wallet.title")}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {perVenue ? t("wallet.introVenue") : t("wallet.intro")}
          </p>
        </div>
        <div className="text-2xl font-bold text-teal-700">{money(balance)}</div>
      </div>

      {perVenue && balances.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {balances.map((b) => (
            <li key={b.venueId ?? "any"} className="flex justify-between gap-3">
              <span className="text-slate-600">{b.venueName ?? t("wallet.anyVenue")}</span>
              <span className="font-semibold">{money(b.balance)}</span>
            </li>
          ))}
        </ul>
      )}

      {topUpVenues.length > 0 &&
        (topUp ? (
          <div className="mt-3 space-y-2 rounded-lg border border-teal-200 bg-teal-50/60 p-3 text-sm">
            <div className="flex flex-wrap items-end gap-2">
              {topUpVenues.length > 1 && (
                <label className="text-xs text-slate-600">
                  {t("wallet.topUpAt")}{" "}
                  <select
                    value={topUp.venueId}
                    onChange={(e) => setTopUp({ ...topUp, venueId: Number(e.target.value) })}
                    className="mt-0.5 block rounded-md border border-slate-300 px-2 py-1 text-sm"
                  >
                    {topUpVenues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="text-xs text-slate-600">
                {t("wallet.topUpAmount")}
                <input
                  type="number"
                  min={10}
                  max={1000}
                  step={0.01}
                  value={topUp.amount}
                  onChange={(e) => setTopUp({ ...topUp, amount: e.target.value })}
                  className="mt-0.5 block w-28 rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <button
                onClick={payTopUp}
                disabled={paying || !(Number(topUp.amount) >= 10)}
                className="rounded-lg bg-teal-600 px-4 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {t("wallet.topUpGo", { amount: topUp.amount || 0 })}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {topUpVenues.length === 1 ? `${topUpVenues[0].name}. ` : ""}
              {t("wallet.topUpHow")}
            </p>
            {topUpError && <p className="text-xs font-medium text-red-700">{topUpError}</p>}
          </div>
        ) : (
          <button
            onClick={() => setTopUp({ venueId: topUpVenues[0].id, amount: "50" })}
            className="mt-3 rounded-lg border border-teal-300 px-3 py-1.5 text-sm font-semibold text-teal-700 hover:bg-teal-50"
          >
            {t("wallet.topUp")}
          </button>
        ))}

      <form onSubmit={redeem} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="text-xs text-slate-600">
          {t("wallet.redeem")}
          <input
            aria-label={t("wallet.redeemCode")}
            placeholder="GV-XXXX-XXXX"
            value={voucher}
            onChange={(e) => setVoucher(e.target.value.toUpperCase())}
            className="mt-0.5 block w-40 rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <button
          disabled={voucher.trim().length < 6}
          className="rounded-lg border border-teal-300 px-3 py-1.5 font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
        >
          {t("wallet.redeemGo")}
        </button>
      </form>
      {voucherNote && (
        <p className={`mt-1 text-xs font-medium ${voucherNote.ok ? "text-emerald-700" : "text-red-700"}`}>{voucherNote.text}</p>
      )}

      {entries.length > 0 && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            className="mt-3 text-xs font-semibold text-teal-700 hover:underline"
          >
            {open ? t("wallet.hideHistory") : t("wallet.showHistory")}
          </button>
          {open && (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-slate-600">{entry.reason}</span>
                  <span
                    className={`font-semibold ${
                      entry.amount >= 0 ? "text-emerald-700" : "text-slate-700"
                    }`}
                  >
                    {entry.amount >= 0 ? "+" : "−"}{money(Math.abs(entry.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
