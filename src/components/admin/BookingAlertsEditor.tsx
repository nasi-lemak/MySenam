"use client";

import { useEffect, useState } from "react";
import type { BookingAlerts, ChangeAlerts } from "@/lib/notify";
import { region } from "@/lib/region";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
import { LanguageChoice } from "./LanguageChoice";
import { staffLocales } from "@/lib/staff-locales";

/** How far ahead a customer's online cancellation or change is worth a message: a day unless the venue widens it. */
const WINDOWS: { hours: number | null; phrase: StaffPhrase }[] = [
  { hours: 24, phrase: "p8c.alr.day" },
  { hours: 48, phrase: "p8c.alr.twoDays" },
  { hours: 168, phrase: "p8c.alr.week" },
  { hours: null, phrase: "p8c.alr.any" },
];

/** Where this venue hears about bookings customers make online, and whether also about their online cancellations and changes. */
export function BookingAlertsEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [alerts, setAlerts] = useState<BookingAlerts | null>(null);
  const [form, setForm] = useState({ email: "", phone: "", locale: "", cancellations: false, changes: false, withinHours: 24 as number | null });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAlerts(null);
    void fetch(`/api/admin/booking-alerts?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { alerts?: BookingAlerts; changes?: ChangeAlerts }) => {
        if (!d.alerts) return;
        setAlerts(d.alerts);
        setForm({
          email: d.alerts.email ?? "",
          phone: d.alerts.phone ?? "",
          locale: d.alerts.locale ?? "",
          cancellations: d.changes?.cancellations ?? false,
          changes: d.changes?.changes ?? false,
          withinHours: d.changes ? d.changes.withinHours : 24,
        });
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
        body: JSON.stringify({ venueId, ...form, locale: form.locale || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("vn.couldNotSave")));
      setAlerts(data.alerts);
      setNotice(data.alerts.email || data.alerts.phone ? t("alr.savedOn") : t("alr.savedOff"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  if (!alerts) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">{t("alr.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("alr.intro")}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          {t("c.email")}
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
        {/* The venue's own inbox and phone, not one person's: the alerts' language is chosen with them. */}
        {staffLocales().length > 1 && (
          <label className="text-xs text-slate-600">
            {t("sl8.lang.alerts")}
            <LanguageChoice
              label={t("sl8.lang.alerts")}
              value={form.locale}
              onChange={(locale) => setForm({ ...form, locale })}
              locales={staffLocales()}
              className={`mt-0.5 block ${input}`}
            />
          </label>
        )}
      </div>
      <fieldset className="mt-3 space-y-1">
        <legend className="text-xs font-medium text-slate-600">{t("p8c.alr.changesTitle")}</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.cancellations} onChange={(e) => setForm({ ...form, cancellations: e.target.checked })} />
          {t("p8c.alr.cancellations")}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.changes} onChange={(e) => setForm({ ...form, changes: e.target.checked })} />
          {t("p8c.alr.changes")}
        </label>
        {(form.cancellations || form.changes) && (
          <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            {t("p8c.alr.within")}
            <select
              value={form.withinHours === null ? "" : String(form.withinHours)}
              onChange={(e) => setForm({ ...form, withinHours: e.target.value === "" ? null : Number(e.target.value) })}
              className={input}
            >
              {WINDOWS.map((w) => (
                <option key={String(w.hours)} value={w.hours === null ? "" : String(w.hours)}>
                  {t(w.phrase)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-xs text-slate-500">{t("p8c.alr.note")}</p>
      </fieldset>
      <button disabled={busy} onClick={save} className="mt-3 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
        {t("c.save")}
      </button>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
