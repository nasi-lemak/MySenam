"use client";

import { useEffect, useState } from "react";
import type { ManagedVenue } from "./shared";
import { money } from "@/lib/region";
import type { StaffText } from "@/lib/staff-text";
import { useStaffClock, useStaffT } from "./StaffLanguage";
import { FIRST_PAGE, ListFilter, listParams, type ListQuery } from "./ListFilter";

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
  // Found by number, booking code, name or number, receipts or credit notes, a page at a time (X1-7).
  const [query, setQuery] = useState<ListQuery>(FIRST_PAGE);
  const [more, setMore] = useState(false);

  useEffect(() => {
    setRows(null);
    void fetch(`/api/admin/receipts?venueId=${venueId}${listParams(query)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setRows(d?.receipts ?? []);
        setMore(d?.more === true);
      });
  }, [venueId, query]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t("rcp.title")}</h3>
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
        {t("rcp.intro")}
      </p>
      <ListFilter
        query={query}
        onChange={setQuery}
        more={more}
        placeholder="p8b.list.searchReceipts"
        statuses={[
          { value: "receipt", label: "p8b.list.receipts" },
          { value: "credit_note", label: "p8b.list.creditNotes" },
        ]}
      />
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
