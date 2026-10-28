"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";
import type { StaffText } from "@/lib/staff-text";
import { useStaffClock, useStaffT } from "./StaffLanguage";

interface Row {
  number: string;
  kind: "receipt" | "credit_note";
  customer: string;
  description: string;
  descriptionPhrase: StaffText | null;
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
  const t = useStaffT();
  const clock = useStaffClock();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    setRows(null);
    void fetch(`/api/admin/receipts?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then((d) => setRows(d?.receipts ?? []));
  }, [venueId]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t("rcp.title")}</h3>
        {venues.length > 1 && (
          <select aria-label={t("q8b.l.venue")}
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
        {t("rcp.intro")}
      </p>
      {rows && rows.length === 0 && <p className="mt-2 text-sm text-slate-500">{t("rcp.none")}</p>}
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
                  <td className="py-1.5 pr-2 text-xs text-slate-500">{clock.day(r.issuedAt, venueId)}</td>
                  <td className="py-1.5 pr-2">{r.customer}</td>
                  <td className="py-1.5 pr-2 text-slate-600">
                    {t.say(r.descriptionPhrase, r.description)}
                    {r.credits && <span className="text-amber-700">{` ${t("rcp.reverses", { number: r.credits })}`}</span>}
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
