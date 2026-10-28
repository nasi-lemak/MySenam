"use client";

import { useEffect, useState } from "react";
import type { VenueTax } from "@/lib/tax";
import type { DeductionReason, DeductionReview, DeductionTreatment } from "@/lib/deposit-deductions";
import { useStaffClock, useStaffT } from "./StaffLanguage";

type History = { kind: "changed" | "approved"; changed: Record<string, boolean | null> | null; reviewer: string | null; adminName: string | null; createdAt: string }[];

/**
 * A venue's own sales tax: SST or GST, if it is registered. Prices stay what
 * the customer pays; receipts and reports show the tax inside them.
 */
export function TaxEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const clock = useStaffClock();
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
      if (!res.ok) throw new Error(t.err(data, t("tax.couldNotSave")));
      setTax(data.tax);
      setNotice(registered ? t("tax.savedRegistered", { name: data.tax.name, rate: data.tax.rate }) : t("tax.savedNotRegistered"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tax.couldNotSave"));
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
    if (!res.ok) setError(t.err(data, t("tax.couldNotSave")));
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
    if (!res.ok) return setError(t.err(data, t("tax.couldNotSave")));
    setDeductions(data.deductions);
    setReview(data.deductionReview);
    setHistory(data.deductionHistory ?? []);
    setReviewer("");
    setNotice(t("tax.recordedReviewed"));
  }

  if (!tax) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">{t("tax.title", { name: tax.name })}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("tax.intro", { name: tax.name })}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          {t("tax.called")}
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`mt-0.5 block w-20 ${input}`} />
        </label>
        <label className="text-xs text-slate-600">
          {t("tax.rate")}
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
          {t("tax.regNo")}
          <input value={form.regNo} onChange={(e) => setForm({ ...form, regNo: e.target.value })} className={`mt-0.5 block w-48 ${input}`} />
        </label>
        <button
          disabled={busy}
          onClick={() => save(true)}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {tax.registered ? t("c.save") : t("tax.registered")}
        </button>
        {tax.registered && (
          <button
            disabled={busy}
            onClick={() => save(false)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            {t("tax.notRegistered")}
          </button>
        )}
      </div>
      {tax.registered && (
        <p className="mt-2 text-xs text-emerald-700">
          {t("tax.charging", { name: tax.name, rate: tax.rate ?? "", regNo: tax.regNo ?? "" })}
        </p>
      )}
      {deductions.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="text-xs font-semibold text-slate-700">{t("tax.deductionsTitle")}</h4>
          <p className="mt-1 text-xs text-slate-500">{t("tax.deductionsIntro", { name: tax.name })}</p>
          {review ? (
            <p className="mt-2 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
              {review.approvedBy
                ? t("tax.reviewedRecorded", { reviewer: review.reviewer, date: clock.day(review.approvedAt, venueId), by: review.approvedBy })
                : t("tax.reviewed", { reviewer: review.reviewer, date: clock.day(review.approvedAt, venueId) })}
            </p>
          ) : (
            <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
              {t("tax.provisional")}
            </p>
          )}
          <table className="mt-2 text-xs">
            <tbody>
              {deductions.map((d) => (
                <tr key={d.reason}>
                  <td className="py-0.5 pr-3 text-slate-700">{t(`srv.deduction.${d.reason}`)}</td>
                  <td className="py-0.5">
                    <select
                      aria-label={t("tax.taxOn", { label: t(`srv.deduction.${d.reason}`) })}
                      value={d.usual ? "usual" : d.taxed ? "taxed" : "untaxed"}
                      onChange={(e) => void treat(d.reason, e.target.value === "usual" ? null : e.target.value === "taxed")}
                      className={input}
                    >
                      <option value="usual">{d.usual ? (d.taxed ? t("tax.usualTaxed") : t("tax.usualNotTaxed")) : t("tax.usualAsHere")}</option>
                      <option value="taxed">{t("tax.taxed")}</option>
                      <option value="untaxed">{t("tax.notTaxed")}</option>
                    </select>
                  </td>
                  <td className="py-0.5 pl-2 text-amber-700">{d.basis === "reviewed" ? "" : d.basis === "provisional" ? t("tax.basisProvisional") : t("tax.basisOwn")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!review && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-600">
                {t("tax.reviewedBy")}
                <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder={t("tax.reviewerExample")} className={`mt-0.5 block w-64 ${input}`} />
              </label>
              <button
                disabled={reviewer.trim().length < 3}
                onClick={() => void approve()}
                className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {t("tax.recordReview")}
              </button>
            </div>
          )}
          {history.length > 0 && (
            <details className="mt-2 text-xs text-slate-500">
              <summary className="cursor-pointer">{t("tax.history")}</summary>
              <ul className="mt-1 space-y-0.5">
                {history.map((h, i) => (
                  <li key={i}>
                    {clock.when(h.createdAt, venueId)} ·{" "}
                    {h.kind === "approved"
                      ? t("tax.histReviewed", { reviewer: h.reviewer ?? "" })
                      : t("tax.histChanged", {
                          changes: Object.entries(h.changed ?? {})
                            .map(([r, v]) => `${t.known(`srv.deduction.${r}`) ?? r} → ${v === null ? t("tax.histUsual") : v ? t("tax.histTaxed") : t("tax.histNotTaxed")}`)
                            .join(", "),
                        })}
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
