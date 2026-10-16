"use client";

import { useCallback, useEffect, useState } from "react";
import { WalletBalance, WalletEntry } from "@/lib/types";
import { useT } from "@/components/Language";

/** The customer's stored credit and recent movements. */
export default function Wallet() {
  const t = useT();
  const [balance, setBalance] = useState<number | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [perVenue, setPerVenue] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/my/wallet", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setBalance(data.balance);
      setEntries(data.entries);
      setBalances(data.balances ?? []);
      setPerVenue(data.scope === "venue");
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
        <div className="text-2xl font-bold text-teal-700">RM{balance}</div>
      </div>

      {perVenue && balances.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {balances.map((b) => (
            <li key={b.venueId ?? "any"} className="flex justify-between gap-3">
              <span className="text-slate-600">{b.venueName ?? t("wallet.anyVenue")}</span>
              <span className="font-semibold">RM{b.balance}</span>
            </li>
          ))}
        </ul>
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
                    {entry.amount >= 0 ? "+" : "−"}RM{Math.abs(entry.amount)}
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
