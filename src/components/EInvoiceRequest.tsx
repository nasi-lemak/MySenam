"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { STATE_CODES } from "@/lib/myinvois/states";

const ID_TYPES = ["NRIC", "BRN", "PASSPORT"] as const;

/**
 * "Need an e-invoice?" on a receipt: the customer's tax details, sent to LHDN
 * as an e-invoice made out to them (lib/myinvois.ts). Once sent, the page
 * shows where it stands instead.
 */
export function EInvoiceRequest({ refCode, token }: { refCode: string; token: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    tin: "",
    idType: "NRIC" as (typeof ID_TYPES)[number],
    idNumber: "",
    sst: "",
    email: "",
    phone: "",
    addressLine: "",
    city: "",
    postcode: "",
    stateCode: "",
  });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/receipts/einvoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: refCode, t: token, ...form }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data));
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const field = (key: Exclude<keyof typeof form, "idType">, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input className={input} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </label>
  );

  return (
    <section className="rounded-lg border border-slate-200 p-4 print:hidden">
      <h2 className="font-semibold">{t("einv.title")}</h2>
      <p className="mt-1 text-slate-600">{t("einv.intro")}</p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="mt-3 rounded-md border border-teal-600 px-3 py-1.5 font-medium text-teal-700">
          {t("einv.open")}
        </button>
      ) : (
        <form onSubmit={send} className="mt-3 space-y-3">
          {field("name", t("einv.name"), { required: true, autoComplete: "organization" })}
          <div>
            {field("tin", t("einv.tin"), { required: true, placeholder: "IG12345678910" })}
            <p className="mt-1 text-xs text-slate-500">{t("einv.tinHelp")}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">{t("einv.idType")}</span>
              <select className={input} value={form.idType} onChange={(e) => setForm({ ...form, idType: e.target.value as (typeof ID_TYPES)[number] })}>
                {ID_TYPES.map((id) => (
                  <option key={id} value={id}>
                    {t(`einv.id.${id}`)}
                  </option>
                ))}
              </select>
            </label>
            {field("idNumber", t("einv.idNumber"), { required: true })}
          </div>
          {field("sst", t("einv.sst"))}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("email", t("einv.email"), { required: true, type: "email", autoComplete: "email" })}
            {field("phone", t("einv.phone"), { required: true, type: "tel", autoComplete: "tel" })}
          </div>
          {field("addressLine", t("einv.address"), { required: true, autoComplete: "street-address" })}
          <div className="grid gap-3 sm:grid-cols-3">
            {field("city", t("einv.city"), { required: true })}
            {field("postcode", t("einv.postcode"), { required: true, inputMode: "numeric", autoComplete: "postal-code" })}
            <label className="block text-sm">
              <span className="font-medium text-slate-700">{t("einv.state")}</span>
              <select required className={input} value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>
                <option value="">{t("einv.choose")}</option>
                {Object.entries(STATE_CODES)
                  .filter(([code]) => code !== "17")
                  .map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
            {t("einv.warning")}
          </p>
          {error && <p className="text-rose-700">{error}</p>}
          <button type="submit" disabled={busy} className="rounded-md bg-teal-600 px-4 py-2 font-semibold text-white disabled:opacity-50">
            {busy ? t("einv.sending") : t("einv.send")}
          </button>
        </form>
      )}
    </section>
  );
}
