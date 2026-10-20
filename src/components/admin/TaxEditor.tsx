"use client";

import { useEffect, useState } from "react";
import type { VenueTax } from "@/lib/tax";

/**
 * A venue's own sales tax: SST or GST, if it is registered. Prices stay what
 * the customer pays; receipts and reports show the tax inside them.
 */
export function TaxEditor({ venueId }: { venueId: number }) {
  const [tax, setTax] = useState<VenueTax | null>(null);
  const [form, setForm] = useState({ name: "", rate: "", regNo: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTax(null);
    void fetch(`/api/admin/venue-tax?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { tax?: VenueTax; usual?: { name: string; venueRate: number } }) => {
        if (!d.tax || !d.usual) return;
        setTax(d.tax);
        setForm({
          name: d.tax.name,
          rate: String(d.tax.rate ?? d.usual.venueRate),
          regNo: d.tax.regNo ?? "",
        });
      });
  }, [venueId]);

  async function save(registered: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/venue-tax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, registered, name: form.name, rate: Number(form.rate), regNo: form.regNo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setTax(data.tax);
      setNotice(
        registered
          ? `Saved. Bookings from now on include ${data.tax.name} at ${data.tax.rate}%, shown on receipts and reports.`
          : "Saved. New bookings carry no tax."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!tax) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Tax ({tax.name})</h3>
      <p className="mt-1 text-xs text-slate-500">
        Only if this venue is registered for {tax.name}. Your prices stay what customers pay, tax included; their receipts
        and your reports then show the {tax.name} inside each price, with your registration number. A change applies to
        bookings made from now on. Ask your accountant whether court hire is taxable and at what rate.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Called
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`mt-0.5 block w-20 ${input}`} />
        </label>
        <label className="text-xs text-slate-600">
          Rate (%)
          <input
            type="number"
            min={0}
            max={30}
            step={0.01}
            value={form.rate}
            onChange={(e) => setForm({ ...form, rate: e.target.value })}
            className={`mt-0.5 block w-20 ${input}`}
          />
        </label>
        <label className="text-xs text-slate-600">
          Registration number
          <input value={form.regNo} onChange={(e) => setForm({ ...form, regNo: e.target.value })} className={`mt-0.5 block w-48 ${input}`} />
        </label>
        <button
          disabled={busy}
          onClick={() => save(true)}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {tax.registered ? "Save" : "Registered: charge it"}
        </button>
        {tax.registered && (
          <button
            disabled={busy}
            onClick={() => save(false)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            Not registered
          </button>
        )}
      </div>
      {tax.registered && (
        <p className="mt-2 text-xs text-emerald-700">
          Charging {tax.name} at {tax.rate}%, no. {tax.regNo}.
        </p>
      )}
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
