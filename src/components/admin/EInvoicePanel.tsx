"use client";

import { useCallback, useEffect, useState } from "react";
import type { EInvoice, EInvoiceSettings } from "@/lib/myinvois";
import { STATE_CODES } from "@/lib/myinvois/states";
import { intlTag, money, region } from "@/lib/region";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

/**
 * LHDN e-invoicing (MyInvois) for a Malaysian venue: its tax details, how
 * MySenam reaches MyInvois for it, and what has been sent. Off until a
 * manager turns it on; sandbox until they say production.
 */

const TONE: Record<EInvoice["status"], string> = {
  pending: "bg-slate-100 text-slate-700",
  submitted: "bg-sky-100 text-sky-800",
  valid: "bg-emerald-100 text-emerald-800",
  invalid: "bg-rose-100 text-rose-800",
  failed: "bg-amber-100 text-amber-800",
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
  const t = useStaffT();
  const STATUS: Record<EInvoice["status"], string> = {
    pending: t("einv.status.pending"),
    submitted: t("einv.status.submitted"),
    valid: t("einv.status.valid"),
    invalid: t("einv.status.invalid"),
    failed: t("einv.status.failed"),
  };
  const KIND: Record<EInvoice["kind"], string> = {
    consolidated: t("einv.kind.consolidated"),
    consolidated_credit: t("einv.kind.consolidatedCredit"),
    individual: t("einv.kind.individual"),
  };
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
      if (!res.ok) throw new Error(t.err(data, t("einv.couldNotLoad")));
      setSettings(data.settings);
      setForm(blank(data.settings));
      setList(data.einvoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("einv.couldNotLoad"));
    }
  }, [venueId, t]);

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
      if (!res.ok) throw new Error(t.err(data, t("einv.requestFailed")));
      setNotice(typeof data.period === "string" ? t.plural("einv.consolidatedPeriod", data.made, { period: data.period }) : ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("einv.requestFailed"));
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
        <h2 className="text-lg font-bold">{t("einv.title")}</h2>
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
      <p className="mt-1 text-sm text-slate-500">{t("einv.intro")}</p>
      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">{t("einv.beforeTitle")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>{t("einv.beforeThreshold")}</li>
          <li>{t("einv.beforeSandbox")}</li>
          <li>{t("einv.beforeLarge")}</li>
          <li>{t("einv.beforeOnlyHere")}</li>
          <li>{t("einv.beforeResponsible")}</li>
        </ul>
      </div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}

      {settings && form && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${settings.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                {settings.enabled ? (settings.sandbox ? t("einv.onSandbox") : t("einv.onProduction")) : t("einv.off")}
              </span>
              {settings.missing.length > 0 && settings.missing[0] !== "everything" && (
                <span className="ml-2 text-slate-500">{t("einv.stillNeeded", { list: settings.missing.join(", ") })}</span>
              )}
            </p>
            <button type="button" className="text-sm font-medium text-teal-700 hover:underline" onClick={() => setOpen(!open)}>
              {open ? t("einv.hideSettings") : t("einv.settings")}
            </button>
          </div>
          {open && (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ action: "save", ...form }, t("c.saved"));
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {field("legalName", t("einv.legalName"))}
                {field("tin", t("einv.tin"), { placeholder: "C1234567890" })}
                {field("brn", t("einv.brn"))}
                {field("msicCode", t("einv.msicCode"), { placeholder: "93119", inputMode: "numeric" })}
                {field("msicName", t("einv.msicName"), { placeholder: t("einv.msicNameExample") })}
                {field("phone", t("c.phone"))}
                {field("email", t("c.email"), { type: "email" })}
                {field("addressLine", t("einv.address"))}
                {field("city", t("einv.city"))}
                {field("postcode", t("einv.postcode"), { inputMode: "numeric" })}
                <label className="text-sm">
                  <span className="font-medium text-slate-700">{t("einv.state")}</span>
                  <select className={`${input} mt-1`} value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>
                    <option value="">{t("einv.choose")}</option>
                    {Object.entries(STATE_CODES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="space-y-2 text-sm">
                <legend className="font-medium text-slate-700">{t("einv.howConnects")}</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" checked={form.mode === "own"} onChange={() => setForm({ ...form, mode: "own" })} className="mt-1" />
                  <span>{t("einv.modeOwn")}</span>
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
                    {t("einv.modeIntermediary")}
                    {!settings.intermediaryAvailable && ` ${t("einv.notOffered")}`}
                  </span>
                </label>
              </fieldset>
              {form.mode === "own" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {field("clientId", t("einv.clientId"), { autoComplete: "off" })}
                  {field("clientSecret", t("einv.clientSecret"), {
                    type: "password",
                    autoComplete: "new-password",
                    placeholder: settings.hasSecret ? t("einv.secretSaved") : "",
                  })}
                </div>
              )}
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} />
                  {t("einv.sandbox")}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                  {t("einv.on")}
                </label>
              </div>
              {form.enabled && !form.sandbox && (
                <p className="rounded-md bg-rose-50 p-2 text-sm text-rose-800">
                  {t("einv.productionWarning")}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {t("c.save")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "test" }, t("einv.testOk"))}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {t("einv.test")}
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
              if (window.confirm(t("einv.consolidateConfirm")))
                void act({ action: "consolidate" }, t("einv.consolidated"));
            }}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {t("einv.sendLastMonth")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: "check" }, t("einv.checked"))}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {t("einv.check")}
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
                  {e.refersCode && ` · ${t("einv.corrects", { code: e.refersCode })}`} · {when(e.submittedAt ?? e.createdAt)}
                </p>
                {e.error && <p className="mt-1 text-rose-700">{e.error}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TONE[e.status]}`}>{STATUS[e.status]}</span>
                {e.link && (
                  <a href={e.link} target="_blank" rel="noreferrer" className="text-teal-700 hover:underline">
                    {t("einv.viewAtLhdn")}
                  </a>
                )}
                {(e.status === "failed" || e.status === "invalid") && (
                  <button type="button" disabled={busy} onClick={() => void act({ action: "retry", id: e.id }, t("einv.sentAgain"))} className="text-teal-700 hover:underline">
                    {t("einv.sendAgain")}
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
