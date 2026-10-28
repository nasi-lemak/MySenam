"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { EInvoice, EInvoiceSettings } from "@/lib/myinvois";
import { STATE_CODES } from "@/lib/myinvois/states";
import { money } from "@/lib/region";
import type { ManagedVenue } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * LHDN e-invoicing (MyInvois) for a Malaysian venue: its tax details, how
 * MySenam reaches MyInvois for it, and what has been sent. Off until a
 * manager turns it on; sandbox until they say production.
 *
 * Each document says where it stands, what was sent and when, LHDN's
 * identifiers and reasons as LHDN gave them, and what can be done next:
 * only what the server lists in its `actions` is offered
 * (docs/integrations/myinvois.md#states-and-what-never-changes).
 */

const TONE: Record<EInvoice["status"], string> = {
  pending: "bg-slate-100 text-slate-700",
  submitted: "bg-sky-100 text-sky-800",
  valid: "bg-emerald-100 text-emerald-800",
  invalid: "bg-rose-100 text-rose-800",
  failed: "bg-amber-100 text-amber-800",
  rejected: "bg-rose-100 text-rose-800",
  cancelled: "bg-slate-200 text-slate-700",
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

export function EInvoicePanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const STATUS: Record<EInvoice["status"], string> = {
    pending: t("einv.status.pending"),
    submitted: t("einv.status.submitted"),
    valid: t("einv.status.valid"),
    invalid: t("einv.status.invalid"),
    failed: t("einv.status.failed"),
    rejected: t("ei7.status.rejected"),
    cancelled: t("ei7.status.cancelled"),
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
  const [shown, setShown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/einvoicing?venueId=${venueId}`, { cache: "no-store" });
      const data = await readJson(res);
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("einv.requestFailed")));
      setNotice(typeof data.period === "string" ? t.plural("einv.consolidatedPeriod", data.made, { period: data.period }) : ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("einv.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** What staff can do next with a document in its state: the same rules the server applies (`actions`). */
  const nextStep = (e: EInvoice): string => {
    if (e.clearedAt) return t("ei8.cleared", { when: clock.when(e.clearedAt, e.venueId) });
    if (e.replacedByCode) return t("ei7.next.replaced");
    if (e.waitingFor) return t("ei7.waitingFor", { code: e.waitingFor });
    if (e.replaceBlocked === "consolidated") return t("ei7.next.blockedConsolidated");
    if (e.replaceBlocked === "newer") return t("ei7.next.blockedNewer");
    if (e.actions.includes("replace"))
      return e.kind === "individual" && e.buyerName ? `${t("ei7.next.refused")} ${t("ei7.next.customerDetails")}` : t("ei7.next.refused");
    switch (e.status) {
      case "pending":
        return t("ei7.next.pending");
      case "failed":
        return t("ei7.next.failed");
      case "submitted":
        return t("ei7.next.submitted");
      case "valid":
        return t("ei7.next.valid");
      case "cancelled":
        return t("ei7.next.cancelled");
      default:
        return t("ei7.next.refused");
    }
  };

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
          <select aria-label={t("q8b.l.venue")}
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
          <li>{t("ei7.beforeUnverified")}</li>
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
                <span className="ml-2 text-slate-500">
                  {t("einv.stillNeeded", { list: settings.missing.map((m, i) => t.say(settings.missingPhrases?.[i], m)).join(t("srv.list.comma")) })}
                </span>
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
              <p className="text-sm text-slate-600">{t("ei8.namesNever")}</p>
              {form.enabled && !form.sandbox && (
                <p className="rounded-md bg-rose-50 p-2 text-sm text-rose-800">
                  {t("ei7.productionWarning")}
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
            <li key={e.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {e.codeNumber}{" "}
                    <span className="font-normal text-slate-500">
                      · {e.largeSale ? t("ei7.kind.largeSale") : KIND[e.kind]}
                      {e.buyerName ? `, ${e.buyerName}` : ""}
                    </span>
                  </p>
                  <p className="text-slate-500">
                    {money(e.total)}
                    {e.refersCode && ` · ${t("einv.corrects", { code: e.refersCode })}`} ·{" "}
                    {e.submittedAt ? t("ei7.sentAt", { when: clock.when(e.submittedAt, venueId) }) : clock.when(e.createdAt, venueId)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TONE[e.status]}`}>{STATUS[e.status]}</span>
                  {e.link && (
                    <a href={e.link} target="_blank" rel="noreferrer" className="text-teal-700 hover:underline">
                      {t("einv.viewAtLhdn")}
                    </a>
                  )}
                  {e.actions.includes("send") && (
                    <button type="button" disabled={busy} onClick={() => void act({ action: "retry", id: e.id }, t("ei7.sent"))} className="text-teal-700 hover:underline">
                      {t("ei7.send")}
                    </button>
                  )}
                  {e.actions.includes("replace") && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t("ei7.replaceConfirm", { code: e.codeNumber }))) void act({ action: "retry", id: e.id }, t("ei7.replaced"));
                      }}
                      className="text-teal-700 hover:underline"
                    >
                      {t("ei7.replace")}
                    </button>
                  )}
                  {e.actions.includes("recheck") && (
                    <button type="button" disabled={busy} onClick={() => void act({ action: "recheck", id: e.id }, t("ei7.rechecked"))} className="text-teal-700 hover:underline">
                      {t("ei7.recheck")}
                    </button>
                  )}
                </div>
              </div>
              {e.replacesCode && <p className="text-slate-600">{t("ei7.replaces", { code: e.replacesCode })}</p>}
              {e.replacedByCode && <p className="text-slate-600">{t("ei7.replacedBy", { code: e.replacedByCode })}</p>}
              {e.error && (
                <p className="text-rose-700">
                  {e.status === "rejected"
                    ? t("ei7.refusedWhy", { why: e.error })
                    : e.status === "invalid"
                      ? t("ei7.invalidWhy", { why: e.error })
                      : t("ei7.notSentWhy", { why: e.error })}
                </p>
              )}
              {(e.submissionUid || e.uuid) && (
                <p className="break-all font-mono text-xs text-slate-500">
                  {[
                    e.submissionUid && `${t("ei7.submissionId")} ${e.submissionUid}`,
                    e.uuid && `${t("ei7.uuid")} ${e.uuid}`,
                    e.longId && `${t("ei7.longId")} ${e.longId}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {e.checkedAt && <p className="text-xs text-slate-500">{t("ei7.checkedAt", { when: clock.when(e.checkedAt, venueId) })}</p>}
              {e.correctedBy.length > 0 && <p className="text-slate-600">{t("ei7.correctedBy", { list: e.correctedBy.join(t("srv.list.comma")) })}</p>}
              <p className="text-xs text-slate-600">{nextStep(e)}</p>
              {e.sentLines && (
                <div>
                  <button type="button" className="text-xs font-medium text-teal-700 hover:underline" onClick={() => setShown(shown === e.id ? null : e.id)}>
                    {shown === e.id ? t("ei7.hideSent") : t("ei7.showSent")}
                  </button>
                  {shown === e.id && (
                    <ul className="mt-1 space-y-0.5 rounded-md bg-slate-50 p-2 text-xs text-slate-700">
                      {e.sentLines.map((l, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span className="min-w-0 break-words">{l.description}</span>
                          <span className="shrink-0">{money(l.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
