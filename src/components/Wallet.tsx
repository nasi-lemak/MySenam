"use client";

import { useCallback, useEffect, useState } from "react";
import { WalletEntry } from "@/lib/types";
import { useT } from "@/components/Language";

/** The customer's stored credit and recent movements. */
export default function Wallet() {
  const t = useT();
  const [balance, setBalance] = useState<number | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/my/wallet", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setBalance(data.balance);
      setEntries(data.entries);
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
            {t("wallet.intro")}
          </p>
        </div>
        <div className="text-2xl font-bold text-teal-700">RM{balance}</div>
      </div>

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
