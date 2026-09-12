"use client";

import { useState } from "react";
import { formatHour } from "@/lib/time";
import { SPORT_ICONS } from "@/lib/types";
import type { AdminBookingRow } from "@/lib/store";

export default function AdminPage() {
  const [passcode, setPasscode] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [bookings, setBookings] = useState<AdminBookingRow[] | null>(null);
  const [revenue, setRevenue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/bookings?date=${date}`, {
        headers: { "x-admin-passcode": passcode },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setBookings(data.bookings);
      setRevenue(data.revenue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setBookings(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Admin — Daily Bookings</h1>
        <p className="mt-1 text-sm text-slate-600">
          View all bookings and revenue for a day. Requires the admin passcode.
        </p>
      </div>

      <form
        onSubmit={load}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Passcode
          <input
            type="password"
            required
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Date
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Load bookings"}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {bookings && (
        <>
          <div className="flex flex-wrap gap-4">
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
              <div className="text-xs font-medium text-slate-500">Bookings</div>
              <div className="text-2xl font-bold">{bookings.length}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
              <div className="text-xs font-medium text-slate-500">Confirmed revenue</div>
              <div className="text-2xl font-bold text-teal-700">RM{revenue}</div>
            </div>
          </div>

          {bookings.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
              No bookings on {date}.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full min-w-[800px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    {["Code", "Venue", "Court", "Time", "Customer", "Phone", "Total", "Status"].map(
                      (h) => (
                        <th key={h} className="px-3 py-2 font-semibold">
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr key={b.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2 font-mono font-medium text-teal-700">{b.code}</td>
                      <td className="px-3 py-2">{b.venueName}</td>
                      <td className="px-3 py-2">
                        {SPORT_ICONS[b.sport]} {b.courtName}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {formatHour(b.startHour)} – {formatHour(b.endHour)}
                      </td>
                      <td className="px-3 py-2">{b.name}</td>
                      <td className="whitespace-nowrap px-3 py-2">{b.phone}</td>
                      <td className="px-3 py-2 font-medium">RM{b.totalPrice}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            b.status === "confirmed"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {b.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
