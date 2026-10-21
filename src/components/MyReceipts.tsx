"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { money } from "@/lib/region";

interface Row {
  number: string;
  kind: "receipt" | "credit_note";
  venueName: string | null;
  description: string;
  total: number;
  issuedAt: string;
  path: string;
}

/**
 * The signed-in customer's receipts for what they bought besides court time
 * (a booking's is on the booking), and any credit notes.
 */
export default function MyReceipts() {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    fetch("/api/my/receipts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setRows(data?.receipts ?? []))
      .catch(() => setRows([]));
  }, []);

  if (rows === null || rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-bold">{t("account.receipts")}</h2>
      <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm shadow-sm">
        {rows.map((r) => (
          <li key={r.number + r.issuedAt} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="min-w-0">
              <span className="font-mono text-xs text-slate-500">{r.number}</span>{" "}
              <span className="font-medium">{r.description}</span>
              {r.venueName && <span className="text-slate-500"> · {r.venueName}</span>}
              <span className="text-slate-500"> · {r.issuedAt.slice(0, 10)}</span>
            </span>
            <span className="flex items-center gap-3">
              <span className="tabular-nums">{r.kind === "credit_note" ? `−${money(r.total)}` : money(r.total)}</span>
              <a href={r.path} className="font-medium text-teal-700 underline">
                {r.kind === "credit_note" ? t("receipt.creditNote") : t("mine.receipt")}
              </a>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
