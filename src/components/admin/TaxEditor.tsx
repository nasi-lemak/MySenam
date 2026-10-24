"use client";

import { useEffect, useState } from "react";
import type { VenueTax } from "@/lib/tax";
import type { DeductionReason, DeductionReview, DeductionTreatment } from "@/lib/deposit-deductions";

type History = { kind: "changed" | "approved"; changed: Record<string, boolean | null> | null; reviewer: string | null; adminName: string | null; createdAt: string }[];

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
  const [deductions, setDeductions] = useState<DeductionTreatment[]>([]);
  const [review, setReview] = useState<DeductionReview | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [reviewer, setReviewer] = useState("");

  useEffect(() => {
    setTax(null);
    void fetch(`/api/admin/venue-tax?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { tax?: VenueTax; usual?: { name: string; venueRate: number }; deductions?: DeductionTreatment[]; deductionReview?: DeductionReview | null; deductionHistory?: History }) => {
        if (!d.tax || !d.usual) return;
        setDeductions(d.deductions ?? []);
        setReview(d.deductionReview ?? null);
        setHistory(d.deductionHistory ?? []);
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

  /** One reason's treatment: taxed, not taxed, or back to the country's usual. */
  async function treat(reason: DeductionReason, value: boolean | null) {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/venue-tax", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, deductions: { [reason]: value } }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not save");
    else {
      setDeductions(data.deductions);
      setReview(data.deductionReview ?? null);
      setHistory(data.deductionHistory ?? []);
    }
  }

  /** Record that the treatments as they stand were reviewed by the adviser named. */
  async function approve() {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/venue-tax", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, approveDeductions: { reviewer } }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Could not save");
    setDeductions(data.deductions);
    setReview(data.deductionReview);
    setHistory(data.deductionHistory ?? []);
    setReviewer("");
    setNotice("Recorded as reviewed. A change to any reason needs reviewing again.");
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
      {deductions.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="text-xs font-semibold text-slate-700">Money kept from a hire deposit</h4>
          <p className="mt-1 text-xs text-slate-500">
            Staff say why they keep money back; this says which reasons carry your {tax.name}. It starts from a provisional
            default for this country: a charge for something you supply is taxed, money that makes good damage or a loss, or a
            penalty, is not. That default has not been reviewed by a tax adviser and is not tax advice. Have your accountant
            review the treatment of each reason, change any they disagree with, and record their review below before relying
            on it.
          </p>
          {review ? (
            <p className="mt-2 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
              Reviewed by {review.reviewer} on {review.approvedAt.slice(0, 10)}
              {review.approvedBy ? `, recorded by ${review.approvedBy}` : ""}.
            </p>
          ) : (
            <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
              Provisional: not reviewed by a tax adviser. Receipts, the journal and exports mark amounts kept on this footing.
            </p>
          )}
          <table className="mt-2 text-xs">
            <tbody>
              {deductions.map((d) => (
                <tr key={d.reason}>
                  <td className="py-0.5 pr-3 text-slate-700">{d.label}</td>
                  <td className="py-0.5">
                    <select
                      aria-label={`Tax on: ${d.label}`}
                      value={d.usual ? "usual" : d.taxed ? "taxed" : "untaxed"}
                      onChange={(e) => void treat(d.reason, e.target.value === "usual" ? null : e.target.value === "taxed")}
                      className={input}
                    >
                      <option value="usual">Usual ({d.usual ? (d.taxed ? "taxed" : "not taxed") : "as here"})</option>
                      <option value="taxed">Taxed</option>
                      <option value="untaxed">Not taxed</option>
                    </select>
                  </td>
                  <td className="py-0.5 pl-2 text-amber-700">{d.basis === "reviewed" ? "" : d.basis === "provisional" ? "provisional default" : "your choice, not reviewed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!review && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-600">
                Reviewed by (adviser and firm)
                <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Lim Mei Ling, LML Tax Advisory" className={`mt-0.5 block w-64 ${input}`} />
              </label>
              <button
                disabled={reviewer.trim().length < 3}
                onClick={() => void approve()}
                className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                Record the review of these treatments
              </button>
            </div>
          )}
          {history.length > 0 && (
            <details className="mt-2 text-xs text-slate-500">
              <summary className="cursor-pointer">Changes and reviews</summary>
              <ul className="mt-1 space-y-0.5">
                {history.map((h, i) => (
                  <li key={i}>
                    {h.createdAt.slice(0, 16)} ·{" "}
                    {h.kind === "approved"
                      ? `reviewed by ${h.reviewer}`
                      : `changed: ${Object.entries(h.changed ?? {}).map(([r, v]) => `${r} → ${v === null ? "usual" : v ? "taxed" : "not taxed"}`).join(", ")}`}
                    {h.adminName ? ` (${h.adminName})` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
