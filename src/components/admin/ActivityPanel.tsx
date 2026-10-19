"use client";

import { useEffect, useState } from "react";
import { ACTION_LABELS, type StaffAction } from "@/lib/activity-labels";
import { localTime } from "./shared";

/**
 * Who did what at this venue over the period: what squares the till at the
 * end of a shift, and answers "who cancelled that booking?". One booking's
 * history by its code.
 */
export function ActivityPanel({ venueId, from, to }: { venueId: number; from: string; to: string }) {
  const [actions, setActions] = useState<StaffAction[] | null>(null);
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    setActions(null);
    const params = new URLSearchParams({ venueId: String(venueId), from, to, limit: "300" });
    if (query) params.set("code", query);
    void fetch(`/api/admin/activity?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { actions: [] }))
      .then((d: { actions?: StaffAction[] }) => setActions(d.actions ?? []));
  }, [venueId, from, to, query]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Staff activity</h2>
          <p className="text-sm text-slate-500">
            Payments marked and how, bookings made, cancelled, moved or changed, prices, refunds, voids, credit and settings.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(code.trim());
          }}
          className="flex gap-2"
        >
          <input
            aria-label="Booking code"
            placeholder="Booking code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <button className="rounded-md border border-slate-300 px-3 py-1 text-sm">{query ? "Search" : "Find"}</button>
          {query && (
            <button
              type="button"
              onClick={() => {
                setCode("");
                setQuery("");
              }}
              className="text-xs text-slate-500 underline"
            >
              All
            </button>
          )}
        </form>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Who</th>
              <th className="px-3 py-2">What</th>
              <th className="px-3 py-2">Booking</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {actions === null ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : actions.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  Nothing recorded {query ? `for ${query}` : "in this period"}.
                </td>
              </tr>
            ) : (
              actions.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                    {a.createdAt.slice(0, 10)} {localTime(a.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-medium">{a.adminName}</td>
                  <td className="px-3 py-2">{ACTION_LABELS[a.action] ?? a.action}</td>
                  <td className="px-3 py-2 font-mono text-xs text-teal-700">{a.bookingCode ?? ""}</td>
                  <td className="px-3 py-2 text-slate-600">{a.detail ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
