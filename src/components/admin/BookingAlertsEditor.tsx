"use client";

import { useEffect, useState } from "react";
import type { BookingAlerts } from "@/lib/notify";
import { region } from "@/lib/region";

/** Where this venue hears about bookings customers make online. */
export function BookingAlertsEditor({ venueId }: { venueId: number }) {
  const [alerts, setAlerts] = useState<BookingAlerts | null>(null);
  const [form, setForm] = useState({ email: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAlerts(null);
    void fetch(`/api/admin/booking-alerts?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { alerts?: BookingAlerts }) => {
        if (!d.alerts) return;
        setAlerts(d.alerts);
        setForm({ email: d.alerts.email ?? "", phone: d.alerts.phone ?? "" });
      });
  }, [venueId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/booking-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setAlerts(data.alerts);
      setNotice(data.alerts.email || data.alerts.phone ? "Saved. You will hear about each booking made online." : "Saved. New-booking alerts are off.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!alerts) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">New-booking alerts</h3>
      <p className="mt-1 text-xs text-slate-500">
        A message each time a customer books online, with their name, number, the court and time. Bookings your staff make
        are not announced. WhatsApp alerts count against this venue&apos;s WhatsApp messages; leave a field blank to stop it.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Email
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="frontdesk@example.com"
            className={`mt-0.5 block w-56 ${input}`}
          />
        </label>
        <label className="text-xs text-slate-600">
          WhatsApp
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder={region().phone.example}
            className={`mt-0.5 block w-40 ${input}`}
          />
        </label>
        <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          Save
        </button>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
