"use client";

import { useCallback, useEffect, useState } from "react";
import type { EInvoice, EInvoiceSettings } from "@/lib/myinvois";
import { STATE_CODES } from "@/lib/myinvois/states";
import { intlTag, money, region } from "@/lib/region";
import type { ManagedVenue } from "./shared";

/**
 * LHDN e-invoicing (MyInvois) for a Malaysian venue: its tax details, how
 * MySenam reaches MyInvois for it, and what has been sent. Off until a
 * manager turns it on; sandbox until they say production.
 */

const STATUS: Record<EInvoice["status"], { label: string; tone: string }> = {
  pending: { label: "Waiting to send", tone: "bg-slate-100 text-slate-700" },
  submitted: { label: "Sent, being validated", tone: "bg-sky-100 text-sky-800" },
  valid: { label: "Valid", tone: "bg-emerald-100 text-emerald-800" },
  invalid: { label: "Invalid", tone: "bg-rose-100 text-rose-800" },
  failed: { label: "Not sent", tone: "bg-amber-100 text-amber-800" },
};

const KIND: Record<EInvoice["kind"], string> = {
  consolidated: "Consolidated",
  consolidated_credit: "Consolidated credit note",
  individual: "Customer's own",
};

type Form = {
  enabled: boolean;
  sandbox: boolean;
  mode: "own" | "intermediary";
  clientId: string;
  clientSecret: string;
  tin: string;
  brn: string;
  msicCode: string;
  msicName: string;
  legalName: string;
  addressLine: string;
  city: string;
  postcode: string;
  stateCode: string;
  phone: string;
  email: string;
};

const blank = (s: EInvoiceSettings): Form => ({
  enabled: s.enabled,
  sandbox: s.sandbox,
  mode: s.mode,
  clientId: s.clientId ?? "",
  clientSecret: "",
  tin: s.tin ?? "",
  brn: s.brn ?? "",
  msicCode: s.msicCode ?? "",
  msicName: s.msicName ?? "",
  legalName: s.legalName ?? "",
  addressLine: s.addressLine ?? "",
  city: s.city ?? "",
  postcode: s.postcode ?? "",
  stateCode: s.stateCode ?? "",
  phone: s.phone ?? "",
  email: s.email ?? "",
});

const when = (at: string) =>
  new Date(at.includes("Z") || at.includes("+") ? at : `${at.replace(" ", "T")}Z`).toLocaleString(intlTag("en"), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: region().timeZone,
  });

export function EInvoicePanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [settings, setSettings] = useState<EInvoiceSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [list, setList] = useState<EInvoice[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/einvoicing?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load e-invoicing");
      setSettings(data.settings);
      setForm(blank(data.settings));
      setList(data.einvoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load e-invoicing");
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/einvoicing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setNotice(typeof data.period === "string" ? `${ok} ${data.period}: ${data.made} document${data.made === 1 ? "" : "s"}.` : ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const field = (key: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    form && (
      <label className="text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <input
          className={`${input} mt-1`}
          value={form[key] as string}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          {...props}
        />
      </label>
    );

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">E-invoicing (LHDN MyInvois)</h2>
        {venues.length > 1 && (
          <select
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Each month, in its first week, last month&apos;s sales go to LHDN as one consolidated e-invoice, with credit notes
        against it. A customer who needs their own (a company claiming the expense) asks from their receipt before then,
        and theirs goes at once.
      </p>
      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Before you turn this on</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            Whether and from when your business must e-invoice depends on its annual turnover, and LHDN has moved the
            exemption threshold more than once. Check with your accountant or LHDN: this setting does not decide it for
            you.
          </li>
          <li>Run it in sandbox first and check the documents in LHDN&apos;s pre-production portal before production.</li>
          <li>
            A single sale above RM10,000 cannot go in the consolidated one: each gets its own e-invoice, to the general
            public unless the customer asked for one in their name. Check those after each month.
          </li>
          <li>Only sales recorded here are included: not another till, nor bank transfers never entered here.</li>
          <li>You remain responsible for what is sent under your TIN. Check the list below after each month.</li>
        </ul>
      </div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}

      {settings && form && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${settings.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                {settings.enabled ? (settings.sandbox ? "On, sandbox" : "On, production") : "Off"}
              </span>
              {settings.missing.length > 0 && settings.missing[0] !== "everything" && (
                <span className="ml-2 text-slate-500">Still needed: {settings.missing.join(", ")}</span>
              )}
            </p>
            <button type="button" className="text-sm font-medium text-teal-700 hover:underline" onClick={() => setOpen(!open)}>
              {open ? "Hide settings" : "Settings"}
            </button>
          </div>
          {open && (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ action: "save", ...form }, "Saved.");
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {field("legalName", "Registered business name")}
                {field("tin", "Tax identification number (TIN)", { placeholder: "C1234567890" })}
                {field("brn", "Business registration number")}
                {field("msicCode", "MSIC code", { placeholder: "93119", inputMode: "numeric" })}
                {field("msicName", "Business activity", { placeholder: "Operation of sports facilities" })}
                {field("phone", "Phone")}
                {field("email", "Email", { type: "email" })}
                {field("addressLine", "Address")}
                {field("city", "City")}
                {field("postcode", "Postcode", { inputMode: "numeric" })}
                <label className="text-sm">
                  <span className="font-medium text-slate-700">State</span>
                  <select className={`${input} mt-1`} value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>
                    <option value="">Choose…</option>
                    {Object.entries(STATE_CODES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="space-y-2 text-sm">
                <legend className="font-medium text-slate-700">How this connects to MyInvois</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" checked={form.mode === "own"} onChange={() => setForm({ ...form, mode: "own" })} className="mt-1" />
                  <span>With your own ERP client ID and secret, registered in the MyInvois portal.</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    checked={form.mode === "intermediary"}
                    disabled={!settings.intermediaryAvailable}
                    onChange={() => setForm({ ...form, mode: "intermediary" })}
                    className="mt-1"
                  />
                  <span>
                    Through the platform as your intermediary. Name the platform as an intermediary in the MyInvois
                    portal first.
                    {!settings.intermediaryAvailable && " (Not offered on this install.)"}
                  </span>
                </label>
              </fieldset>
              {form.mode === "own" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {field("clientId", "Client ID", { autoComplete: "off" })}
                  {field("clientSecret", "Client secret", {
                    type: "password",
                    autoComplete: "new-password",
                    placeholder: settings.hasSecret ? "Saved — leave blank to keep" : "",
                  })}
                </div>
              )}
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} />
                  Sandbox (LHDN pre-production)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                  On
                </label>
              </div>
              {form.enabled && !form.sandbox && (
                <p className="rounded-md bg-rose-50 p-2 text-sm text-rose-800">
                  Production: documents go to LHDN under your TIN and cannot be withdrawn after 72 hours.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  Save
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "test" }, "MyInvois accepted the credentials.")}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Test connection
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {settings?.enabled && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Send last month's sales to LHDN now as a consolidated e-invoice? Customers can no longer ask for their own for that month afterwards."))
                void act({ action: "consolidate" }, "Consolidated");
            }}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Send last month now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: "check" }, "Checked with LHDN.")}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            Check with LHDN
          </button>
        </div>
      )}

      {list.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {list.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {e.codeNumber} <span className="font-normal text-slate-500">· {KIND[e.kind]}{e.buyerName ? `, ${e.buyerName}` : ""}</span>
                </p>
                <p className="text-slate-500">
                  {money(e.total)}
                  {e.refersCode && ` · corrects ${e.refersCode}`} · {when(e.submittedAt ?? e.createdAt)}
                </p>
                {e.error && <p className="mt-1 text-rose-700">{e.error}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS[e.status].tone}`}>{STATUS[e.status].label}</span>
                {e.link && (
                  <a href={e.link} target="_blank" rel="noreferrer" className="text-teal-700 hover:underline">
                    View at LHDN
                  </a>
                )}
                {(e.status === "failed" || e.status === "invalid") && (
                  <button type="button" disabled={busy} onClick={() => void act({ action: "retry", id: e.id }, "Sent again.")} className="text-teal-700 hover:underline">
                    Send again
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
