"use client";

import { useEffect, useState } from "react";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";

interface Row {
  number: string;
  kind: "receipt" | "credit_note";
  customer: string;
  description: string;
  total: number;
  tax: number;
  credits: string | null;
  issuedAt: string;
  path: string;
}

/**
 * The venue's receipts for passes, memberships, credit and fees, and its
 * credit notes, newest first: to reprint one for a customer, or check one.
 * A booking's receipt is on the booking.
 */
export function ReceiptsPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    setRows(null);
    void fetch(`/api/admin/receipts?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRows(d?.receipts ?? []));
  }, [venueId]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Receipts and credit notes</h3>
        {venues.length > 1 && (
          <select
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Numbered in order as each pass, membership, top-up, entry, league fee or share is paid, and a credit note when one
        is cancelled, refunded or voided. Open one to print it. A booking&apos;s receipt is on the booking.
      </p>
      {rows && rows.length === 0 && <p className="mt-2 text-sm text-slate-500">None yet.</p>}
      {rows && rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.number + r.kind} className="border-t border-slate-100">
                  <td className="py-1.5 pr-2 font-mono text-xs">
                    <a href={r.path} target="_blank" rel="noreferrer" className="text-teal-700 underline">
                      {r.number}
                    </a>
                  </td>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">{r.issuedAt.slice(0, 10)}</td>
                  <td className="py-1.5 pr-2">{r.customer}</td>
                  <td className="py-1.5 pr-2 text-slate-600">
                    {r.description}
                    {r.credits && <span className="text-amber-700"> (reverses {r.credits})</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{r.kind === "credit_note" ? `−${money(r.total)}` : money(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
