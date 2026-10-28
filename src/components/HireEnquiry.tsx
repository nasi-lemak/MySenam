"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { ENQUIRY_KINDS, type EnquiryKind } from "@/lib/enquiries-shared";
import { todayISO } from "@/lib/time";

/**
 * Private hire and events (lib/enquiries.ts): not a slot on the grid but a
 * question for the venue, which answers with a price.
 */
export default function HireEnquiry({ venueId, venueName }: { venueId: number; venueName: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", kind: "event" as EnquiryKind, wantedOn: "", people: "", message: "", website: "" });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/venues/${venueId}/enquiry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, people: form.people === "" ? null : Number(form.people) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("form.failed"));
      setSent(form.phone);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("form.failed"));
    } finally {
      setSending(false);
    }
  }

  const input = "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none";
  const label = "flex flex-col text-xs font-medium text-slate-500";
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
      <h2 className="font-semibold text-slate-900">🎉 {t("hire.title")}</h2>
      <p className="mt-1 text-slate-600">{t("hire.intro", { venue: venueName })}</p>
      {sent ? (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">{t("hire.sent", { venue: venueName, phone: sent })}</p>
      ) : !open ? (
        <button type="button" onClick={() => setOpen(true)} className="mt-2 text-sm font-medium text-teal-700 hover:underline">
          {t("hire.open")}
        </button>
      ) : (
        <form onSubmit={send} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className={label}>
            {t("form.name")}
            <input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("form.phone")}
            <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("hire.email")}
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("hire.kind")}
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as EnquiryKind })} className={input}>
              {ENQUIRY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`hire.kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("hire.date")}
            <input type="date" min={todayISO()} value={form.wantedOn} onChange={(e) => setForm({ ...form, wantedOn: e.target.value })} className={input} />
          </label>
          <label className={label}>
            {t("hire.people")}
            <input type="number" min={1} value={form.people} onChange={(e) => setForm({ ...form, people: e.target.value })} className={input} />
          </label>
          <label className={`${label} sm:col-span-2`}>
            {t("hire.message")}
            <textarea required minLength={10} maxLength={1000} rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className={input} />
          </label>
          {/* Nobody fills this in but a script. */}
          <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} className="hidden" />
          {error && <p className="text-sm text-red-700 sm:col-span-2">{error}</p>}
          <div className="sm:col-span-2">
            <button disabled={sending} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
              {sending ? t("hire.sending") : t("hire.send")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
